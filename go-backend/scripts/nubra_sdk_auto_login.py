"""Nubra SDK auto-login helper.

Reads credentials from environment variables only:
  NUBRA_PHONE
  NUBRA_MPIN
  NUBRA_TOTP_SECRET

The SDK asks for TOTP interactively; this script patches input/getpass so every
prompt receives a fresh 6-digit TOTP generated from the shared secret.
"""

import base64
import builtins
import getpass
import hashlib
import hmac
import os
from pathlib import Path
import struct
import sys
import time
from email.utils import parsedate_to_datetime

import requests
from nubra_python_sdk.start_sdk import InitNubraSdk, NubraEnv


def clean_secret(secret: str) -> str:
    return "".join(secret.strip().split()).upper()


NUBRA_PROD_BASE_URL = "https://api2.nubra.io"


def nubra_server_time() -> int:
    try:
        response = requests.head(NUBRA_PROD_BASE_URL, timeout=5)
        date_header = response.headers.get("Date")
        if date_header:
            return int(parsedate_to_datetime(date_header).timestamp())
    except Exception:
        pass
    return int(time.time())


def totp_now(secret: str, for_time: int | None = None) -> str:
    clean = clean_secret(secret)
    if not clean:
        raise ValueError("NUBRA_TOTP_SECRET is empty")
    missing = len(clean) % 8
    if missing:
        clean += "=" * (8 - missing)
    key = base64.b32decode(clean, casefold=True)
    counter = int((for_time or nubra_server_time()) // 30)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{code % 1_000_000:06d}"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    if value.lower().startswith("your_"):
        raise RuntimeError(f"Replace placeholder value for {name} in .env.local")
    return value


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    load_env_file(repo_root / ".env.local")
    load_env_file(repo_root / ".env")

    phone = require_env("NUBRA_PHONE")
    mpin = require_env("NUBRA_MPIN")
    secret = require_env("NUBRA_TOTP_SECRET")

    os.environ["PHONE_NO"] = phone
    os.environ["MPIN"] = mpin

    def auto_input(prompt: str = "") -> str:
        normalized = prompt.lower()
        if "totp" in normalized:
            return totp_now(secret)
        if "mpin" in normalized:
            return mpin
        if "phone" in normalized:
            return phone
        raise RuntimeError(f"Unexpected interactive prompt from Nubra SDK: {prompt!r}")

    def auto_getpass(prompt: str = "") -> str:
        return auto_input(prompt)

    def prompt_and_verify_totp_once(self, phone_number: str, x_device_id: str, max_attempts: int = 1) -> str:
        return self._totp_login(phone_number, x_device_id, totp=totp_now(secret))

    original_login = InitNubraSdk._login

    def strict_login(self):
        result = original_login(self)
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(result["error"])
        return result

    InitNubraSdk._InitNubraSdk__prompt_and_verify_totp = prompt_and_verify_totp_once
    InitNubraSdk._login = strict_login

    builtins.input = auto_input
    getpass.getpass = auto_getpass

    nubra = InitNubraSdk(
        env=NubraEnv.PROD,
        totp_login=True,
        env_creds=True,
    )
    if not getattr(nubra, "HEADERS", {}).get("Authorization"):
        raise RuntimeError("Nubra SDK did not return an authenticated session")
    print("Nubra SDK login successful")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Nubra SDK login failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
