# GPU sampler for Hearth.
#
# Runs as one long-lived process and prints a JSON line per sample. The manager
# reads the stream, so the cost of a sample is the counter window itself rather
# than a fresh PowerShell start every time.
#
# Get-Counter needs two readings a second apart to compute a rate, so each
# sample costs about two seconds. That is the floor; sampling faster is not
# possible with these counters.

param([int]$ParentPid = 0)

$ErrorActionPreference = 'SilentlyContinue'

# Total VRAM is not exposed by any counter. The registry value is 64-bit and
# accurate, unlike Win32_VideoController.AdapterRAM which overflows at 4 GB.
$total = 0
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000'
$q = (Get-ItemProperty -Path $key -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
if ($q) { $total = [math]::Round($q / 1GB, 2) }

while ($true) {
  # If the manager was killed outright its child would otherwise keep sampling
  # forever, so the loop ends when the parent is gone.
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    exit
  }

  $c = Get-Counter -Counter `
      '\GPU Engine(*engtype_3D)\Utilization Percentage', `
      '\GPU Adapter Memory(*)\Dedicated Usage' `
      -SampleInterval 2 -MaxSamples 1

  if (-not $c) {
    Write-Output '{"error":"no counters"}'
    Start-Sleep -Seconds 2
    continue
  }

  $util = ($c.CounterSamples | Where-Object { $_.Path -like '*Utilization*' } |
           Measure-Object CookedValue -Sum).Sum
  $used = ($c.CounterSamples | Where-Object { $_.Path -like '*Dedicated*' } |
           Measure-Object CookedValue -Sum).Sum

  $o = [ordered]@{
    util     = [math]::Round($util, 1)
    vramUsed = [math]::Round($used / 1GB, 2)
    vramTotal = $total
  }
  Write-Output ($o | ConvertTo-Json -Compress)
}
