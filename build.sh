#!/usr/bin/env bash
set -e
mkdir -p dist
# dashboard.html es la ÚNICA fuente de verdad (mismo archivo que usa Cowork).
# Lo envolvemos en un HTML completo para servirlo como web, sin modificar el master.
{
  echo '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'
  cat dashboard.html
  echo '</body></html>'
} > dist/index.html
# Inyecta el Google Client ID (público) en el login desde la variable de entorno (Netlify o Cloudflare)
sed "s|__GOOGLE_CLIENT_ID__|${GOOGLE_CLIENT_ID}|g" web/login.html > dist/login.html
# _redirects para el fallback SPA (Cloudflare Pages lo lee desde el directorio de salida)
cp _redirects dist/_redirects
echo "Build OK: dist/index.html + dist/login.html + dist/_redirects"
