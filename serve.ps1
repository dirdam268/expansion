# serve.ps1 - servidor local de pruebas (http://localhost:8780) sirviendo index-src.html
param([int]$Port = 8780, [string]$File = 'index-src.html')
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
        $bytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $File))
        $ctx.Response.ContentType = 'text/html; charset=utf-8'
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch { $ctx.Response.StatusCode = 500 }
    $ctx.Response.OutputStream.Close()
}

