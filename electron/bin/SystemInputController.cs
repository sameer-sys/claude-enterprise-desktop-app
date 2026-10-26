using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SystemInputController {
    class Program {
        [DllImport("user32.dll")]
        static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;

        const uint KEYEVENTF_KEYUP = 0x0002;

        static void Main(string[] args) {
            try {
                if (args.Length == 0) {
                    Point p = Cursor.Position;
                    Console.WriteLine("{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}");
                    return;
                }

                string cmd = args[0].ToLower();
                if (cmd == "pos") {
                    Point p = Cursor.Position;
                    Console.WriteLine("{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}");
                } else if (cmd == "move" && args.Length >= 3) {
                    int targetX = int.Parse(args[1]);
                    int targetY = int.Parse(args[2]);
                    bool smooth = args.Length >= 4 && (args[3].ToLower() == "smooth" || args[3].ToLower() == "true");
                    if (!smooth) {
                        SetCursorPos(targetX, targetY);
                    } else {
                        HumanMove(targetX, targetY, 20);
                    }
                    Console.WriteLine("{\"ok\":true,\"x\":" + targetX + ",\"y\":" + targetY + "}");
                } else if (cmd == "click" && args.Length >= 3) {
                    int x = int.Parse(args[1]);
                    int y = int.Parse(args[2]);
                    string button = args.Length >= 4 ? args[3].ToLower() : "left";
                    bool dbl = args.Length >= 5 && (args[4].ToLower() == "double" || args[4].ToLower() == "true");

                    HumanMove(x, y, 12);
                    Thread.Sleep(25);

                    if (button == "right") {
                        mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
                        Thread.Sleep(25);
                        mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
                    } else if (button == "middle") {
                        mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
                        Thread.Sleep(25);
                        mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                    } else {
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                        Thread.Sleep(25);
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                        if (dbl) {
                            Thread.Sleep(80);
                            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                            Thread.Sleep(25);
                            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                        }
                    }
                    Console.WriteLine("{\"ok\":true,\"clicked\":true,\"x\":" + x + ",\"y\":" + y + ",\"button\":\"" + button + "\"}");
                } else if (cmd == "drag" && args.Length >= 5) {
                    int x1 = int.Parse(args[1]);
                    int y1 = int.Parse(args[2]);
                    int x2 = int.Parse(args[3]);
                    int y2 = int.Parse(args[4]);
                    SetCursorPos(x1, y1);
                    Thread.Sleep(30);
                    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                    Thread.Sleep(40);
                    HumanMove(x2, y2, 25);
                    Thread.Sleep(30);
                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                    Console.WriteLine("{\"ok\":true,\"dragged\":true,\"from\":[" + x1 + "," + y1 + "],\"to\":[" + x2 + "," + y2 + "]}");
                } else if (cmd == "type" && args.Length >= 2) {
                    string text = args[1];
                    Random rnd = new Random();
                    foreach (char c in text) {
                        SendKeys.SendWait(EscapeKey(c));
                        Thread.Sleep(rnd.Next(20, 55));
                    }
                    Console.WriteLine("{\"ok\":true,\"typed\":\"" + text.Length + " characters\"}");
                } else if (cmd == "hotkey" && args.Length >= 2) {
                    string keys = args[1].ToLower().Trim();
                    ExecuteHotkey(keys);
                    Console.WriteLine("{\"ok\":true,\"hotkey\":\"" + keys + "\"}");
                } else {
                    Console.WriteLine("{\"ok\":false,\"error\":\"Unknown command\"}");
                }
            } catch (Exception ex) {
                Console.WriteLine("{\"ok\":false,\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}");
            }
        }

        static void ExecuteHotkey(string keys) {
            string[] parts = keys.Split(new char[] { '+', '-' }, StringSplitOptions.RemoveEmptyEntries);
            bool ctrl = false, alt = false, shift = false;
            string key = "";

            foreach (string p in parts) {
                string part = p.Trim();
                if (part == "ctrl" || part == "control") ctrl = true;
                else if (part == "alt") alt = true;
                else if (part == "shift") shift = true;
                else key = part;
            }

            string sendPattern = "";
            if (ctrl) sendPattern += "^";
            if (alt) sendPattern += "%";
            if (shift) sendPattern += "+";

            if (key == "enter" || key == "return") sendPattern += "{ENTER}";
            else if (key == "tab") sendPattern += "{TAB}";
            else if (key == "esc" || key == "escape") sendPattern += "{ESC}";
            else if (key == "backspace") sendPattern += "{BACKSPACE}";
            else if (key == "up") sendPattern += "{UP}";
            else if (key == "down") sendPattern += "{DOWN}";
            else if (key == "left") sendPattern += "{LEFT}";
            else if (key == "right") sendPattern += "{RIGHT}";
            else if (key == "space") sendPattern += " ";
            else if (key.Length > 0) sendPattern += key;

            if (!string.IsNullOrEmpty(sendPattern)) {
                SendKeys.SendWait(sendPattern);
            }
        }

        static string EscapeKey(char c) {
            string s = c.ToString();
            if ("+^%~{}[]()".IndexOf(c) >= 0) return "{" + s + "}";
            return s;
        }

        static void HumanMove(int targetX, int targetY, int steps) {
            Point start = Cursor.Position;
            Random rnd = new Random();
            double ctrlX = (start.X + targetX) / 2.0 + rnd.Next(-25, 25);
            double ctrlY = (start.Y + targetY) / 2.0 + rnd.Next(-25, 25);

            for (int i = 1; i <= steps; i++) {
                double t = (double)i / steps;
                double x = Math.Pow(1 - t, 2) * start.X + 2 * (1 - t) * t * ctrlX + Math.Pow(t, 2) * targetX;
                double y = Math.Pow(1 - t, 2) * start.Y + 2 * (1 - t) * t * ctrlY + Math.Pow(t, 2) * targetY;
                SetCursorPos((int)x, (int)y);
                Thread.Sleep(rnd.Next(4, 10));
            }
            SetCursorPos(targetX, targetY);
        }
    }
}
