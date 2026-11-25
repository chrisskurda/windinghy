// Installs a driver from an *inbox* INF section onto a device, even when that INF doesn't list the
// device's IDs: the scripted equivalent of Device Manager > Update driver > Let me pick > (untick
// "Show compatible hardware"). Inbox INFs are Microsoft-signed, so Code Integrity accepts them where
// a self-signed driver package is refused. Used by guest-fixes.ps1 via Add-Type.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class InboxDriver
{
    [StructLayout(LayoutKind.Sequential)]
    struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SP_DRVINFO_DATA
    {
        public int cbSize; public int DriverType; public IntPtr Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Description;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string MfgName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string ProviderName;
        public long DriverDate; public long DriverVersion;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SP_DEVINSTALL_PARAMS
    {
        public int cbSize; public int Flags; public int FlagsEx; public IntPtr hwndParent;
        public IntPtr InstallMsgHandler; public IntPtr InstallMsgHandlerContext; public IntPtr FileQueue;
        public IntPtr ClassInstallReserved; public int Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DriverPath;
    }

    const int DIGCF_ALLCLASSES = 0x4;
    const int SPDIT_CLASSDRIVER = 1;
    const int SPDRP_FRIENDLYNAME = 0x0C;
    const int SPDRP_CLASSGUID = 0x08;
    const int DI_ENUMSINGLEINF = 0x00010000;
    const int DI_FLAGSEX_ALLOWEXCLUDEDDRVS = 0x00000800;
    const int DIIRFLAG_FORCE_INF = 0x00000002;

    [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr classGuid, IntPtr hwnd);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiOpenDeviceInfo(IntPtr set, string instanceId, IntPtr hwnd, int flags, ref SP_DEVINFO_DATA data);
    [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInstallParams(IntPtr set, ref SP_DEVINFO_DATA data, ref SP_DEVINSTALL_PARAMS p);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiSetDeviceInstallParams(IntPtr set, ref SP_DEVINFO_DATA data, ref SP_DEVINSTALL_PARAMS p);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set, ref SP_DEVINFO_DATA data, int prop, byte[] buf, int size);
    [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiBuildDriverInfoList(IntPtr set, ref SP_DEVINFO_DATA data, int type);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiEnumDriverInfo(IntPtr set, ref SP_DEVINFO_DATA data, int type, int index, ref SP_DRVINFO_DATA drv);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiGetDriverInfoDetail(IntPtr set, ref SP_DEVINFO_DATA data, ref SP_DRVINFO_DATA drv, IntPtr detail, int size, out int required);
    [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool DiInstallDevice(IntPtr hwnd, IntPtr set, ref SP_DEVINFO_DATA data, ref SP_DRVINFO_DATA drv, int flags, out bool reboot);

    static void Check(bool ok, string what) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), what); }

    // SP_DRVINFO_DETAIL_DATA: SectionName starts after cbSize, FILETIME, 2 DWORDs and a ULONG_PTR.
    static string SectionName(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DRVINFO_DATA drv)
    {
        int ptr = IntPtr.Size;
        int sectionOffset = ptr == 8 ? 32 : 24;
        int cbSize = ptr == 8 ? 1584 : 1572;   // sizeof(SP_DRVINFO_DETAIL_DATA_W)
        IntPtr buf = Marshal.AllocHGlobal(65536);
        try {
            Marshal.WriteInt32(buf, cbSize);
            int req;
            if (!SetupDiGetDriverInfoDetail(set, ref dev, ref drv, buf, 65536, out req)) return null;
            return Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + sectionOffset));
        } finally { Marshal.FreeHGlobal(buf); }
    }

    /// Install section `section` of inbox INF `infPath` (class `classGuid`) on device `instanceId`.
    /// Returns true if a reboot is needed.
    public static bool Install(string instanceId, string infPath, string section, Guid classGuid, string friendlyName)
    {
        IntPtr set = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
        if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetupDiCreateDeviceInfoList");
        try {
            var dev = new SP_DEVINFO_DATA { cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA)) };
            Check(SetupDiOpenDeviceInfo(set, instanceId, IntPtr.Zero, 0, ref dev), "SetupDiOpenDeviceInfo " + instanceId);

            // Unknown devices have no class (and a UAS drive is SCSIAdapter): the class driver list is
            // built for the device's class, so give it the target class first.
            byte[] g = System.Text.Encoding.Unicode.GetBytes(classGuid.ToString("B") + "\0");
            Check(SetupDiSetDeviceRegistryProperty(set, ref dev, SPDRP_CLASSGUID, g, g.Length), "set class");
            dev = new SP_DEVINFO_DATA { cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA)) };
            Check(SetupDiOpenDeviceInfo(set, instanceId, IntPtr.Zero, 0, ref dev), "reopen");

            var p = new SP_DEVINSTALL_PARAMS { cbSize = Marshal.SizeOf(typeof(SP_DEVINSTALL_PARAMS)) };
            Check(SetupDiGetDeviceInstallParams(set, ref dev, ref p), "get install params");
            p.Flags |= DI_ENUMSINGLEINF;
            p.FlagsEx |= DI_FLAGSEX_ALLOWEXCLUDEDDRVS;
            p.DriverPath = infPath;
            Check(SetupDiSetDeviceInstallParams(set, ref dev, ref p), "set install params");
            Check(SetupDiBuildDriverInfoList(set, ref dev, SPDIT_CLASSDRIVER), "build driver list");

            var drv = new SP_DRVINFO_DATA { cbSize = Marshal.SizeOf(typeof(SP_DRVINFO_DATA)) };
            bool found = false;
            for (int i = 0; SetupDiEnumDriverInfo(set, ref dev, SPDIT_CLASSDRIVER, i, ref drv); i++) {
                string s = SectionName(set, ref dev, ref drv);
                if (s != null && s.Equals(section, StringComparison.OrdinalIgnoreCase)) { found = true; break; }
                drv = new SP_DRVINFO_DATA { cbSize = Marshal.SizeOf(typeof(SP_DRVINFO_DATA)) };
            }
            if (!found) throw new InvalidOperationException("No model using section " + section + " in " + infPath);

            bool reboot;
            Check(DiInstallDevice(IntPtr.Zero, set, ref dev, ref drv, DIIRFLAG_FORCE_INF, out reboot), "DiInstallDevice " + instanceId);

            if (!string.IsNullOrEmpty(friendlyName)) {
                byte[] n = System.Text.Encoding.Unicode.GetBytes(friendlyName + "\0");
                SetupDiSetDeviceRegistryProperty(set, ref dev, SPDRP_FRIENDLYNAME, n, n.Length);
            }
            return reboot;
        } finally { SetupDiDestroyDeviceInfoList(set); }
    }
}
