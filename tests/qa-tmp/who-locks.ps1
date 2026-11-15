param([string]$Target, [string]$Out)

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RmProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, out uint lpdwRebootReasons);

    public static string[] Who(string path) {
        var list = new List<string>();
        uint handle;
        var key = new StringBuilder(512);
        int rv = RmStartSession(out handle, 0, key);
        if (rv != 0) { list.Add("RmStartSession failed: " + rv); return list.ToArray(); }
        try {
            rv = RmRegisterResources(handle, 1, new string[] { path }, 0, null, 0, null);
            if (rv != 0) { list.Add("RmRegisterResources failed: " + rv); return list.ToArray(); }
            uint needed = 0, count = 0, reasons;
            rv = RmGetList(handle, out needed, ref count, null, out reasons);
            if (rv != 0 && rv != 234) { list.Add("RmGetList(1) failed: " + rv); return list.ToArray(); }
            if (needed == 0) { list.Add("no holder"); return list.ToArray(); }
            var arr = new RM_PROCESS_INFO[needed];
            count = needed;
            rv = RmGetList(handle, out needed, ref count, arr, out reasons);
            if (rv != 0) { list.Add("RmGetList(2) failed: " + rv); return list.ToArray(); }
            for (int i = 0; i < count; i++) {
                list.Add(arr[i].Process.dwProcessId + "\t" + arr[i].strAppName + "\t" + arr[i].ApplicationType);
            }
        } finally {
            RmEndSession(handle);
        }
        return list.ToArray();
    }
}
'@

Add-Type -TypeDefinition $src -Language CSharp | Out-Null
$rows = [RmProbe]::Who($Target)
Set-Content -LiteralPath $Out -Value (($rows -join "`r`n")) -Encoding utf8
