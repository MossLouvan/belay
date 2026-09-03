// Host clipboard access for the `clipboard` verb (get/set) — Windows side.
//
// STATUS: WRITTEN-BUT-NOT-COMPILED. There is no Windows machine or csc.exe in
// the environment this was written in. Compile it with native/build.ps1 on a
// real Windows box before believing a word of it.
//
// System.Windows.Forms.Clipboard (already referenced by build.ps1) is the
// stable, driverless way at the OLE clipboard, but it demands an STA thread
// and the helper's stdio loop is MTA. Each call therefore runs on a short-
// lived STA thread and joins — clipboard traffic is a human pressing a button,
// not a frame loop, so a thread per call costs nothing that matters.
//
// The cap mirrors MAX_CLIPBOARD_UNITS in server/src/clipboard.ts and is
// counted the same way (UTF-16 code units — .NET string Length). Node
// validates before sending; the helper clamps again because stdin is a
// boundary of its own.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class BelayHostClipboard
{
    /// Mirrors MAX_CLIPBOARD_UNITS in server/src/clipboard.ts.
    const int MaxTextUnits = 100000;

    /// How long one clipboard operation may take before it is reported as a
    /// failure. The OLE clipboard can be held open by another process; a bound
    /// here keeps a wedged clipboard from wedging the whole stdio loop.
    const int OperationTimeoutMs = 3000;

    internal static void Handle(TextWriter w, object id, Dictionary<string, object> c)
    {
        object actionObj;
        c.TryGetValue("action", out actionObj);
        string action = actionObj as string ?? "";
        switch (action)
        {
            case "get": DoGet(w, id); break;
            case "set": DoSet(w, id, c); break;
            default: BelayHost.Err(w, id, "unknown clipboard action: " + action); break;
        }
    }

    static void DoGet(TextWriter w, object id)
    {
        string error = null;
        string text = "";
        RunSta(delegate
        {
            // ContainsText → GetText avoids the exception path for non-text
            // content; an image-only clipboard reads as empty text — that is
            // an answer, not an error.
            if (Clipboard.ContainsText(TextDataFormat.UnicodeText))
                text = Clipboard.GetText(TextDataFormat.UnicodeText) ?? "";
        }, ref error);
        if (error != null) { BelayHost.Err(w, id, "clipboard read failed: " + error); return; }

        var payload = new Dictionary<string, object> { { "id", id }, { "ok", true } };
        if (text.Length > MaxTextUnits)
        {
            // Cut on a code-unit boundary that cannot split a surrogate pair:
            // back off one unit when the last kept unit is a high surrogate.
            int cut = char.IsHighSurrogate(text[MaxTextUnits - 1]) ? MaxTextUnits - 1 : MaxTextUnits;
            payload["text"] = text.Substring(0, cut);
            payload["truncated"] = true;
        }
        else
        {
            payload["text"] = text;
        }
        BelayHost.Reply(w, payload);
    }

    static void DoSet(TextWriter w, object id, Dictionary<string, object> c)
    {
        object textObj;
        c.TryGetValue("text", out textObj);
        string text = textObj as string;
        if (text == null) { BelayHost.Err(w, id, "'text' is required for set"); return; }
        if (text.Length > MaxTextUnits)
        {
            BelayHost.Err(w, id, "clipboard text exceeds the " + MaxTextUnits + "-unit cap");
            return;
        }

        string error = null;
        RunSta(delegate
        {
            // SetText throws on empty string; Clear is how "empty" is spelled.
            if (text.Length == 0) Clipboard.Clear();
            else Clipboard.SetText(text, TextDataFormat.UnicodeText);
        }, ref error);
        if (error != null) { BelayHost.Err(w, id, "clipboard write failed: " + error); return; }
        BelayHost.Reply(w, new Dictionary<string, object> { { "id", id }, { "ok", true }, { "set", true } });
    }

    /// Run `work` on a fresh STA thread and wait for it, bounded. A timeout or
    /// a thrown exception lands in `error`; success leaves it null.
    static void RunSta(ThreadStart work, ref string error)
    {
        string captured = null;
        var thread = new Thread(delegate ()
        {
            try { work(); }
            catch (Exception e) { captured = e.Message; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        if (!thread.Join(OperationTimeoutMs))
        {
            // The thread is abandoned, not aborted: Thread.Abort is unreliable
            // and the background flag keeps it from pinning process exit.
            error = "the clipboard did not respond within " + OperationTimeoutMs + "ms "
                  + "(another application may be holding it open)";
            return;
        }
        error = captured;
    }
}
