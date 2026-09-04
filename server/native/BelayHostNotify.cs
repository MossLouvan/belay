// BelayHostNotify.cs — a small corner popup on the host's own screen.
//
// Belay's pairing code is deliberately shown ON THE PC, never sent anywhere:
// that is what makes it proof of physical presence. But it only helps if the
// person at the PC can actually see it, and a code printed into a terminal that
// is minimised, scrolled, or running as a background service is invisible. This
// puts it on screen, next to the identity of whoever is asking.
//
// Deliberately not a NotifyIcon balloon: those are suppressed by Focus Assist
// and by "quiet hours" on a new install, which is exactly when someone is
// pairing for the first time. A plain top-most form always shows.
//
// SESSION NOTE: this draws on the session the helper runs in. A helper started
// from a service or a session-0 context has no visible desktop, so the popup
// goes nowhere. `notify` reports { shown: false, reason: "..." } in that case
// rather than pretending it worked.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class BelayHostNotify
{
    // At most one popup at a time; a second request replaces the first.
    static Form current;
    static Thread uiThread;
    static readonly object gate = new object();

    public static void Handle(TextWriter stdout, object id, Dictionary<string, object> c)
    {
        string title = c.ContainsKey("title") && c["title"] != null ? c["title"].ToString() : "Belay";
        string body = c.ContainsKey("body") && c["body"] != null ? c["body"].ToString() : "";
        string accent = c.ContainsKey("accent") && c["accent"] != null ? c["accent"].ToString() : "";
        int seconds = 12;
        if (c.ContainsKey("seconds") && c["seconds"] != null)
        {
            try { seconds = Convert.ToInt32(c["seconds"]); } catch { }
        }
        if (seconds < 2) seconds = 2;
        if (seconds > 120) seconds = 120;

        string reason = null;
        bool shown = Show(title, body, accent, seconds, out reason);

        var reply = new Dictionary<string, object> {
            { "id", id }, { "ok", true }, { "shown", shown },
        };
        if (!shown && reason != null) reply["reason"] = reason;
        BelayHost.Reply(stdout, reply);
    }

    static bool Show(string title, string body, string accent, int seconds, out string reason)
    {
        reason = null;
        try
        {
            // No interactive desktop (service / session 0) means nothing to draw on.
            if (!Environment.UserInteractive)
            {
                reason = "helper is not running in an interactive session";
                return false;
            }
            if (Screen.PrimaryScreen == null)
            {
                reason = "no screen available";
                return false;
            }

            lock (gate)
            {
                CloseCurrent();

                var ready = new ManualResetEvent(false);
                uiThread = new Thread(delegate ()
                {
                    Form f = Build(title, body, accent, seconds);
                    lock (gate) { current = f; }
                    ready.Set();
                    try { Application.Run(f); } catch { }
                    lock (gate) { if (current == f) current = null; }
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

    static void CloseCurrent()
    {
        Form f = current;
        if (f == null) return;
        try
        {
            if (f.IsHandleCreated) f.BeginInvoke((MethodInvoker)delegate { try { f.Close(); } catch { } });
        }
        catch { }
        current = null;
    }

    static Form Build(string title, string body, string accent, int seconds)
    {
        var f = new Form();
        f.FormBorderStyle = FormBorderStyle.None;
        f.ShowInTaskbar = false;
        f.TopMost = true;
        f.StartPosition = FormStartPosition.Manual;
        f.BackColor = Color.FromArgb(24, 24, 27);
        f.Width = 380;
        f.Height = string.IsNullOrEmpty(accent) ? 116 : 152;

        var work = Screen.PrimaryScreen.WorkingArea;
        f.Left = work.Right - f.Width - 24;
        f.Top = work.Bottom - f.Height - 24;

        var lblTitle = new Label();
        lblTitle.Text = title;
        lblTitle.ForeColor = Color.FromArgb(250, 250, 250);
        lblTitle.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
        lblTitle.SetBounds(18, 14, f.Width - 36, 22);
        lblTitle.BackColor = Color.Transparent;

        var lblBody = new Label();
        lblBody.Text = body;
        lblBody.ForeColor = Color.FromArgb(190, 190, 195);
        lblBody.Font = new Font("Segoe UI", 9f);
        lblBody.SetBounds(18, 40, f.Width - 36, 40);
        lblBody.BackColor = Color.Transparent;

        f.Controls.Add(lblTitle);
        f.Controls.Add(lblBody);

        if (!string.IsNullOrEmpty(accent))
        {
            var lblAccent = new Label();
            lblAccent.Text = accent;
            lblAccent.ForeColor = Color.FromArgb(120, 220, 160);
            // Monospace and wide-tracked: this is read off the screen and typed
            // into a phone, so legibility beats prettiness.
            lblAccent.Font = new Font("Consolas", 22f, FontStyle.Bold);
            lblAccent.SetBounds(18, 84, f.Width - 36, 44);
            lblAccent.BackColor = Color.Transparent;
            f.Controls.Add(lblAccent);
        }

        // Click to dismiss, on the form and on every child (labels eat clicks).
        EventHandler dismiss = delegate { try { f.Close(); } catch { } };
        f.Click += dismiss;
        foreach (Control ctl in f.Controls) ctl.Click += dismiss;

        var timer = new System.Windows.Forms.Timer();
        timer.Interval = seconds * 1000;
        timer.Tick += delegate { timer.Stop(); try { f.Close(); } catch { } };
        f.Shown += delegate { timer.Start(); };
        f.FormClosed += delegate { try { timer.Dispose(); } catch { } };

        return f;
    }
}
