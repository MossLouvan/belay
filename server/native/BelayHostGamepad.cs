// .NET Framework 4.x / csc.exe. No NuGet dependency; ViGEm is loaded only on demand.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class BelayHostGamepad
{
    // ViGEmClient C API is cdecl; notification callbacks are CALLBACK/stdcall.
    // XUSB_REPORT is TWELVE bytes, passed BY VALUE (not a pointer/ref).
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct XUSB_REPORT
    {
        public ushort wButtons;
        public byte bLeftTrigger, bRightTrigger;
        public short sThumbLX, sThumbLY, sThumbRX, sThumbRY;
    }
    const string Dll = "ViGEmClient.dll";
    const uint Success = 0x20000000;
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern IntPtr vigem_alloc();
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern uint vigem_connect(IntPtr client);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern void vigem_disconnect(IntPtr client);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern void vigem_free(IntPtr client);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern IntPtr vigem_target_x360_alloc();
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern uint vigem_target_add(IntPtr client, IntPtr target);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern uint vigem_target_remove(IntPtr client, IntPtr target);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern void vigem_target_free(IntPtr target);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern uint vigem_target_x360_update(IntPtr client, IntPtr target, XUSB_REPORT report);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern uint vigem_target_x360_register_notification(IntPtr client, IntPtr target, Notification callback, IntPtr userData);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)] static extern void vigem_target_x360_unregister_notification(IntPtr target);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void Notification(IntPtr client, IntPtr target, byte largeMotor, byte smallMotor, byte ledNumber, IntPtr userData);
    static readonly Notification callback = Rumble; // rooted for the full native subscription lifetime
    static readonly object gate = new object();
    static readonly bool[] held = new bool[256], desired = new bool[256];
    static readonly Native.INPUT[] injection = new Native.INPUT[1];
    static readonly int[] bits = { 4096,8192,16384,32768,256,512,1,2,4,8,16,32,128,1024,2048 };
    static readonly ushort[] genericKeys = { 32,17,82,70,81,69,38,40,37,39,27,9,0,0,0 };
    static readonly ushort[] robloxKeys = { 32,17,82,70,81,69,38,40,37,39,27,9,16,0,0 };
    static readonly ushort[] fortniteKeys = { 32,17,82,70,81,69,90,88,67,86,27,9,0,70,71 };
    static ushort[] keys = genericKeys;
    static IntPtr client, target;
    static bool probed, added, registered, attached, leftMouse, rightMouse;
    static volatile bool rumbleEnabled;
    static string reason;
    static TextWriter output;
    static System.Threading.Timer timer;
    static XUSB_REPORT report;
    static double lx, ly, rx, ry, lt, rt;
    static double carryX, carryY;
    static int buttons;
    static long received, lastTick;
    static bool dirty;
    static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();

    static void Check(uint result, string operation)
    {
        if (result != Success) throw new InvalidOperationException(operation + " failed (0x" + result.ToString("X8") + ")");
    }
    static void Probe()
    {
        if (probed) return;
        probed = true;
        try
        {
            if (Marshal.SizeOf(typeof(XUSB_REPORT)) != 12) throw new InvalidOperationException("Invalid XUSB_REPORT packing");
            client = vigem_alloc();
            if (client == IntPtr.Zero) throw new InvalidOperationException("ViGEm allocation failed");
            Check(vigem_connect(client), "Install controller support on the Windows host: ViGEmBus connect");
        }
        catch (DllNotFoundException) { reason = "Install the x64 controller runtime on the Windows host (ViGEmClient.dll)."; FreeDriver(); }
        catch (BadImageFormatException) { reason = "The Windows host needs the x64 controller runtime; its installed DLL has the wrong architecture."; FreeDriver(); }
        catch (Exception e) { reason = e.Message; FreeDriver(); }
    }
    static void FreeDriver()
    {
        rumbleEnabled = false;
        // Callback never acquires gate: unregister may wait for that callback.
        if (target != IntPtr.Zero)
        {
            try { if (registered) vigem_target_x360_unregister_notification(target); } catch { }
            try { if (added) vigem_target_remove(client, target); } catch { }
            try { vigem_target_free(target); } catch { }
            target = IntPtr.Zero; added = false; registered = false;
        }
        if (client != IntPtr.Zero)
        {
            try { vigem_disconnect(client); } catch { }
            try { vigem_free(client); } catch { }
            client = IntPtr.Zero;
        }
    }
    public static void Status(TextWriter w, object id)
    {
        lock (gate) { Probe(); ReplyStatus(w, id); }
    }
    static void ReplyStatus(TextWriter w, object id)
    {
        BelayHost.Reply(w, new Dictionary<string, object> {
            {"id",id}, {"ok",true}, {"gamepad", client != IntPtr.Zero ? "available" : "unavailable"},
            {"backend",client != IntPtr.Zero ? "vigem" : "keymap"}, {"reason",reason}
        });
    }
    public static void Attach(TextWriter w, object id, Dictionary<string, object> command)
    {
        lock (gate)
        {
            Neutral(); FreeDriver(); probed = false; reason = null; Probe();
            output = w;
            object preset; command.TryGetValue("preset", out preset);
            keys = (preset as string) == "roblox" ? robloxKeys : (preset as string) == "fortnite" ? fortniteKeys : genericKeys;
            if (client != IntPtr.Zero)
            {
                try
                {
                    target = vigem_target_x360_alloc();
                    if (target == IntPtr.Zero) throw new InvalidOperationException("Xbox target allocation failed");
                    Check(vigem_target_add(client,target), "Xbox target add"); added = true;
                    uint notificationResult = vigem_target_x360_register_notification(client,target,callback,IntPtr.Zero);
                    registered = notificationResult == Success;
                    rumbleEnabled = registered;
                    if (!registered) reason = "Xbox input available; rumble registration failed";
                }
                catch (Exception e) { reason = e.Message; FreeDriver(); }
            }
            attached = true; received = lastTick = clock.ElapsedMilliseconds;
            if (timer == null) timer = new System.Threading.Timer(Tick, null, 8, 8);
            ReplyStatus(w,id);
        }
    }
    public static void Detach()
    {
        lock (gate)
        {
            attached = false;
            if (timer != null) { timer.Dispose(); timer = null; }
            Neutral(); FreeDriver(); probed = false;
        }
    }
    static double Number(Dictionary<string,object> c, string key, double min, double max)
    {
        object value;
        if (!c.TryGetValue(key,out value) || !(value is int || value is long || value is double || value is decimal)) throw new ArgumentException("Invalid gamepad axis");
        double number = Convert.ToDouble(value);
        if (double.IsNaN(number) || double.IsInfinity(number) || number < min || number > max) throw new ArgumentException("Gamepad value out of range");
        return number;
    }
    public static void State(Dictionary<string,object> c)
    {
        // Parse into stack locals, validate everything before changing held state.
        double b = Number(c,"buttons",0,65535);
        if (b != Math.Floor(b)) throw new ArgumentException("Invalid gamepad buttons");
        double nlx=Number(c,"lx",-1,1), nly=Number(c,"ly",-1,1), nrx=Number(c,"rx",-1,1), nry=Number(c,"ry",-1,1);
        double nlt=Number(c,"lt",0,1), nrt=Number(c,"rt",0,1);
        lock (gate)
        {
            if (!attached) return;
            buttons=(int)b; lx=nlx; ly=nly; rx=nrx; ry=nry; lt=nlt; rt=nrt;
            report.wButtons=(ushort)(buttons & 0xF3FF); // app-only Build/Edit never reach XInput
            report.bLeftTrigger=(byte)Math.Round(lt*255); report.bRightTrigger=(byte)Math.Round(rt*255);
            report.sThumbLX=Axis(lx); report.sThumbLY=Axis(ly); report.sThumbRX=Axis(rx); report.sThumbRY=Axis(ry);
            received=clock.ElapsedMilliseconds; dirty=true;
            // Apply edges immediately; timer repeats only relative mouse motion.
            Apply();
        }
    }
    static short Axis(double value) { return (short)Math.Round(value*(value<0?32768:32767)); }
    static bool Threshold(double value, bool down) { return value > (down ? 0.18 : 0.25); }
    static void Apply()
    {
        if (target != IntPtr.Zero)
        {
            if (!dirty) return;
            try { Check(vigem_target_x360_update(client,target,report), "Xbox update"); dirty=false; return; }
            catch (Exception e)
            {
                reason=e.Message; FreeDriver();
                if (output != null) BelayHost.Reply(output,new Dictionary<string,object>{{"type","gamepadstatus"},{"backend","keymap"},{"gamepad","unavailable"},{"reason",reason}});
            }
        }
        Array.Clear(desired,0,desired.Length);
        for (int i=0;i<bits.Length;i++) if (keys[i]!=0 && (buttons & bits[i])!=0) desired[keys[i]]=true;
        desired[87]=Threshold(ly,held[87]); desired[83]=Threshold(-ly,held[83]);
        desired[65]=Threshold(-lx,held[65]); desired[68]=Threshold(lx,held[68]);
        for (ushort key=0;key<256;key++) if (desired[key]!=held[key])
        {
            injection[0]=Native.KeyScan(key,desired[key]);
            Native.SendGamepad(injection); held[key]=desired[key];
        }
        Mouse(rt > (leftMouse?0.08:0.12),ref leftMouse,2,4);
        Mouse(lt > (rightMouse?0.08:0.12),ref rightMouse,8,16);
        dirty=false;
    }
    static void Mouse(bool next,ref bool previous,uint down,uint up)
    {
        if (next==previous) return;
        injection[0]=new Native.INPUT(); injection[0].U.mi.dwFlags=next?down:up;
        Native.SendGamepad(injection); previous=next;
    }
    static void Tick(object ignored)
    {
        lock (gate)
        {
            if (!attached) return;
            long now=clock.ElapsedMilliseconds;
            if (now-received>750) { Neutral(); lastTick=now; return; }
            double dt=Math.Min(32,Math.Max(0,now-lastTick))/1000.0; lastTick=now;
            if (target != IntPtr.Zero) return;
            carryX+=(Math.Abs(rx)>0.12?rx:0)*900*dt;
            carryY-=(Math.Abs(ry)>0.12?ry:0)*900*dt;
            int dx=(int)carryX, dy=(int)carryY; carryX-=dx; carryY-=dy;
            if(dx==0 && dy==0) return;
            injection[0]=new Native.INPUT(); injection[0].U.mi.dx=dx; injection[0].U.mi.dy=dy;
            injection[0].U.mi.dwFlags=1; // MOUSEEVENTF_MOVE, relative, no ABSOLUTE
            Native.SendGamepad(injection);
        }
    }
    static void Neutral()
    {
        buttons=0; lx=ly=rx=ry=lt=rt=carryX=carryY=0; report=new XUSB_REPORT(); dirty=true;
        Apply();
    }
    static void Rumble(IntPtr c, IntPtr t, byte low, byte high, byte led, IntPtr userData)
    {
        if (!rumbleEnabled || output==null || t != target || c != client) return;
        try { BelayHost.Reply(output,new Dictionary<string,object>{{"type","rumble"},{"low",low/255.0},{"high",high/255.0}}); }
        catch { /* stdout closed: never unwind through the unmanaged callback */ }
    }
}
