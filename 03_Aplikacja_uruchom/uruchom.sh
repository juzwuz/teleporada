#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")/../02_Aplikacja_kod"
exec node server.mjs
