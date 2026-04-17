# Script de Compilacion del Agente FlowerNode (V4 - Modo Task)

$AgentPath = Join-Path $PSScriptRoot "..\agente\node_agent.py"
$OutputPrefix = "FlowerNodeAgent"

Write-Host "--- FlowerNode DevOps Build (V4 - Robust Mode) ---" -ForegroundColor Cyan

Set-Location $PSScriptRoot

# Compilacion limpia: Sin ventana, un solo archivo
Write-Host "Compilando ejecutable independiente..." -ForegroundColor Yellow
& py -m PyInstaller --onefile `
                    --clean `
                    --name $OutputPrefix `
                    --distpath . `
                    $AgentPath

if ($LASTEXITCODE -eq 0) {
    Write-Host "--- COMPILACION COMPLETADA ---" -ForegroundColor Green
} else {
    Write-Host "Error durante la compilacion." -ForegroundColor Red
}
