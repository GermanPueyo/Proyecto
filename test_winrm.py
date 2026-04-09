import sys
sys.path.append('.')
from app.database import get_server, get_all_servers
servers = get_all_servers()
sid = next(s for s in servers if s['ip'] == '192.168.56.101')['id']
server = get_server(sid)
pwd = server['password']
user = server['username']
import winrm
ws = winrm.Session('192.168.56.101', auth=(user,pwd), transport='ntlm', server_cert_validation='ignore')
ps = r'''
$ErrorActionPreference='SilentlyContinue';
$c = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime;
$m = Get-CimInstance Win32_OperatingSystem;
$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'";
$s = Get-CimInstance Win32_PerfFormattedData_PerfOS_System;
$ni = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface;
$net = ($ni | Measure-Object BytesTotalPersec -Sum).Sum;
"@{$([int]$c);$([double]$m.FreePhysicalMemory);$([int]$m.NumberOfProcesses);$([int]$s.Threads);$([double]$d.PercentDiskTime);$([double]$d.DiskReadBytesPersec);$([double]$d.DiskWriteBytesPersec);$([double]$net)}"
'''
res = ws.run_ps(ps)
print("OUT:", res.std_out.decode('utf-8', errors='ignore'))
print("ERR:", res.std_err.decode('utf-8', errors='ignore'))
