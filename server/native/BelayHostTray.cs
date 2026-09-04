// BelayHostTray.cs — a tray icon showing whether Belay is running and whether
// anyone is currently on the desktop.
//
// The point is presence: Belay runs hidden, elevated, at logon, so without this
// there is nothing on screen to say it is running at all, let alone that a phone
// is driving the machine right now. The icon changes colour when a client is
// connected, and the tooltip names who.
//
// Icon is drawn in code rather than shipped as a .ico so the helper stays a
// single self-contained exe built by csc with no resources.
//
// SESSION NOTE: like the popup, this needs an interactive desktop. In session 0
// there is no tray, and `tray` replies { shown:false, reason:... }.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class BelayHostTray
{
    static NotifyIcon icon;
    static Thread uiThread;
    static ApplicationContext ctx;
    static readonly object gate = new object();
    static string currentTip = "Belay";
    static bool currentActive;

    public static void Handle(TextWriter stdout, object id, Dictionary<string, object> c)
    {
        string action = c.ContainsKey("action") && c["action"] != null ? c["action"].ToString() : "show";
        string tip = c.ContainsKey("tooltip") && c["tooltip"] != null ? c["tooltip"].ToString() : "Belay";
        bool active = false;
        if (c.ContainsKey("active") && c["active"] != null)
        {
            try { active = Convert.ToBoolean(c["active"]); } catch { }
        }

        string reason = null;
        bool ok;
        if (action == "hide") { ok = Hide(out reason); }
        else { ok = Show(tip, active, out reason); }

        var reply = new Dictionary<string, object> {
            { "id", id }, { "ok", true }, { "shown", ok },
        };
        if (!ok && reason != null) reply["reason"] = reason;
        BelayHost.Reply(stdout, reply);
    }

    static bool Hide(out string reason)
    {
        reason = null;
        lock (gate)
        {
            try
            {
                if (icon != null) { icon.Visible = false; icon.Dispose(); icon = null; }
                if (ctx != null) { ctx.ExitThread(); ctx = null; }
            }
            catch (Exception ex) { reason = ex.Message; return false; }
        }
        return true;
    }

    static bool Show(string tip, bool active, out string reason)
    {
        reason = null;
        try
        {
            if (!Environment.UserInteractive)
            {
                reason = "helper is not running in an interactive session";
                return false;
            }

            lock (gate)
            {
                currentTip = tip;
                currentActive = active;

                if (icon != null)
                {
                    // Already up: just restyle it in place on its own thread.
                    Apply();
                    return true;
                }

                var ready = new ManualResetEvent(false);
                uiThread = new Thread(delegate ()
                {
                    icon = new NotifyIcon();
                    icon.Icon = Draw(currentActive);
                    // Tooltips are capped at 63 chars by the shell; longer text
                    // silently shows nothing at all.
                    icon.Text = Clamp(currentTip);
                    icon.Visible = true;

                    var menu = new ContextMenuStrip();
                    var status = new ToolStripMenuItem(Clamp(currentTip));
                    status.Enabled = false;
                    status.Name = "status";
                    menu.Items.Add(status);
                    menu.Items.Add(new ToolStripSeparator());
                    var hideItem = new ToolStripMenuItem("Hide this icon");
                    hideItem.Click += delegate { string r; Hide(out r); };
                    menu.Items.Add(hideItem);
                    icon.ContextMenuStrip = menu;

                    ctx = new ApplicationContext();
                    ready.Set();
                    try { Application.Run(ctx); } catch { }
                    lock (gate) { icon = null; ctx = null; }
                });
                uiThread.IsBackground = true;   // never keeps the helper alive
                uiThread.SetApartmentState(ApartmentState.STA);
                uiThread.Start();
                ready.WaitOne(5000);
            }
            return true;
        }
        catch (Exception ex)
        {
            reason = ex.Message;
            return false;
        }
    }

    static string Clamp(string s)
    {
        if (string.IsNullOrEmpty(s)) return "Belay";
        return s.Length > 62 ? s.Substring(0, 62) : s;
    }

    /// Push the current tooltip/state onto the icon from its own UI thread.
    static void Apply()
    {
        NotifyIcon n = icon;
        if (n == null) return;
        try
        {
            n.Text = Clamp(currentTip);
            Icon fresh = Draw(currentActive);
            Icon old = n.Icon;
            n.Icon = fresh;
            if (old != null) old.Dispose();
            if (n.ContextMenuStrip != null && n.ContextMenuStrip.Items.ContainsKey("status"))
                n.ContextMenuStrip.Items["status"].Text = Clamp(currentTip);
        }
        catch { }
    }

    /// Belay's mark: a rope arc with a carabiner hanging off it. Orange while
    /// idle, green while a client is actually on the desktop, so the state is
    /// readable at 16x16 without reading the tooltip.
    static Icon Draw(bool active)
    {
        Color rope = active ? Color.FromArgb(80, 220, 140) : Color.FromArgb(255, 106, 40);
        using (var bmp = new Bitmap(32, 32))
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            using (var pen = new Pen(rope, 3.2f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                // The rope: a shallow catenary across the top.
                g.DrawBezier(pen, new PointF(1, 9), new PointF(10, 20),
                                  new PointF(22, 20), new PointF(31, 9));
            }
            using (var pen = new Pen(Color.FromArgb(225, 225, 230), 2.6f))
            {
                // The carabiner: an oval hanging from the low point.
                g.DrawEllipse(pen, 11.5f, 15f, 9f, 14f);
            }

            IntPtr h = bmp.GetHicon();
            try { return (Icon)Icon.FromHandle(h).Clone(); }
            finally { DestroyIcon(h); }
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyIcon(IntPtr handle);
}
