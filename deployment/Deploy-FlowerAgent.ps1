<#
.SYNOPSIS
    Deploy-FlowerAgent.ps1 (V4) - Despliegue Robusto vía Tarea Programada.
    Este método es el más compatible para Python 3.14.
#>

$InstallDir = "C:\Program Files\FlowerNode"
$ExeFile = "FlowerNodeAgent.exe"
$TaskName = "FlowerNodeAgentTask"

Write-Host "--- FlowerNode Agent Deployment (Universal V4) ---" -ForegroundColor Cyan

# 1. Elevación de Privilegios
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Este script requiere privilegios de ADMINISTRADOR."
    exit
}

# 2. Limpieza de Servicios Previos (Para evitar conflictos)
$OldServiceName = "FlowerNodeAgent"
if (Get-Service $OldServiceName -ErrorAction SilentlyContinue) {
    Write-Host "Limpiando rastro de servicios antiguos..."
    Stop-Service $OldServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $OldServiceName | Out-Null
    Stop-Process -Name $OldServiceName -Force -ErrorAction SilentlyContinue
}

# 3. Preparar Directorio
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 4. Copiar Binario
Write-Host "Copiando binario al sistema..."
if (Test-Path $ExeFile) {
    Copy-Item -Path $ExeFile -Destination "$InstallDir\" -Force
} else {
    Write-Error "No se encuentra $ExeFile en la carpeta local."
    exit
}

# 5. Crear Tarea Programada (Persistencia Invisible)
Write-Host "Configurando persistencia robusta..."
$FullExePath = Join-Path $InstallDir $ExeFile

# Eliminar tarea si ya existe
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Definir Acción y Disparador
$Action = New-ScheduledTaskAction -Execute $FullExePath
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

# Registrar la Tarea como SYSTEM (Máximo privilegio, totalmente invisible)
Register-ScheduledTask -TaskName $TaskName `
                       -Action $Action `
                       -Trigger $Trigger `
                       -Settings $Settings `
                       -User "SYSTEM" `
                       -RunLevel Highest `
                       -Force | Out-Null

# 6. Iniciar Ahora
Write-Host "Iniciando agente por primera vez..."
Start-ScheduledTask -TaskName $TaskName

Write-Host "DESPLIEGUE COMPLETADO CON EXITO" -ForegroundColor Green
Write-Host "El agente ahora es residente y se ejecutara al arrancar el servidor." -ForegroundColor Gray
