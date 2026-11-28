"""本地加密账号保险箱路由（Windows 原生 DPAPI 加密，零第三方依赖，仅限本机访问）。

安全设计原则：
1. 仅保存用户在工作台保险箱内手动录入的平台账号密码，绝不读取/导入/导出 Chrome 凭据；
2. 密码使用 Windows 原生 CryptProtectData (DPAPI, CRYPTPROTECT_UI_FORBIDDEN) 加密后以 Base64 密文落盘于 data/credential_vault.json，
   仅当前本机 Windows 登录用户可解密，绝不明文落盘；
3. 列表接口默认不返回明文密码，仅当用户主动点击「显示密码」或「复制密码」时调用单条 reveal 接口按需解密；
4. 所有接口严格校验本地来源（localhost / 127.0.0.1 / [::1]），拒绝一切外部来源访问。
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
import secrets
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend.config import DATA_DIR

router = APIRouter(prefix="/api/vault", tags=["credential-vault"])

VAULT_FILE = os.path.join(DATA_DIR, "credential_vault.json")


def _require_local_only(request: Request) -> None:
    """严格限定仅允许本机工作台访问保险箱接口。"""
    origin = (request.headers.get("origin") or "").strip()
    if origin:
        host = urlparse(origin).hostname
        if host not in ("localhost", "127.0.0.1", "::1"):
            raise HTTPException(403, f"保险箱仅允许本地工作台访问（已拒绝来源：{origin}）")
    client_host = request.client.host if request.client else ""
    if client_host and client_host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, f"保险箱禁止非本机 IP 访问（{client_host}）")


# ==================== Windows 原生 DPAPI 加解密 ====================
class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi_encrypt(plaintext: str) -> str:
    """使用 Windows CryptProtectData 对明文进行本机用户级加密，返回 Base64 密文。"""
    raw = plaintext.encode("utf-8")
    if not raw:
        return ""
    if os.name != "nt":
        raise RuntimeError("当前保险箱依赖 Windows DPAPI 加密，非 Windows 环境暂不支持")

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(raw, len(raw))
    blob_in = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DATA_BLOB()

    # CRYPTPROTECT_UI_FORBIDDEN = 0x01
    ok = crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        "GCW_Credential_Vault",
        None,
        None,
        None,
        0x01,
        ctypes.byref(blob_out),
    )
    if not ok:
        raise RuntimeError("Windows DPAPI 加密失败")
    try:
        encrypted = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        return base64.b64encode(encrypted).decode("ascii")
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _dpapi_decrypt(cipher_b64: str) -> str:
    """使用 Windows CryptUnprotectData 解密 Base64 密文。"""
    if not cipher_b64:
        return ""
    if os.name != "nt":
        raise RuntimeError("当前保险箱依赖 Windows DPAPI 解密，非 Windows 环境暂不支持")

    raw = base64.b64decode(cipher_b64.encode("ascii"))
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(raw, len(raw))
    blob_in = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DATA_BLOB()

    ok = crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0x01,
        ctypes.byref(blob_out),
    )
    if not ok:
        raise RuntimeError("Windows DPAPI 解密失败（可能不是当前加密用户或数据已损坏）")
    try:
        plain = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        return plain.decode("utf-8")
    finally:
        kernel32.LocalFree(blob_out.pbData)


def _load_vault() -> list[dict[str, Any]]:
    if not os.path.exists(VAULT_FILE):
        return []
    try:
        with open(VAULT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("items", []) if isinstance(data, dict) else []
    except Exception:
        return []


def _save_vault(items: list[dict[str, Any]]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    payload = {
        "schema": "gcw_credential_vault_v1",
        "encryption": "windows_dpapi_current_user",
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "items": items,
    }
    tmp_path = VAULT_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, VAULT_FILE)


def _mask_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "platform": item.get("platform") or "",
        "site_url": item.get("site_url") or "",
        "username": item.get("username") or "",
        "has_password": bool(item.get("password_enc")),
        "note": item.get("note") or "",
        "created_at": item.get("created_at") or "",
        "updated_at": item.get("updated_at") or "",
    }


class VaultItemCreate(BaseModel):
    platform: str
    site_url: str = ""
    username: str
    password: str = ""
    note: str = ""


class VaultItemUpdate(BaseModel):
    platform: Optional[str] = None
    site_url: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None  # 传入 None 或空字符串时默认不覆盖原密码；如需清空可传 clear_password=True
    clear_password: bool = False
    note: Optional[str] = None


@router.get("/items", dependencies=[Depends(_require_local_only)])
def api_vault_list():
    items = _load_vault()
    return {
        "ok": True,
        "encryption": "Windows DPAPI (本机当前用户硬件/系统级加密)",
        "vault_file": VAULT_FILE,
        "items": [_mask_item(x) for x in items],
    }


@router.post("/items", dependencies=[Depends(_require_local_only)])
def api_vault_create(body: VaultItemCreate):
    platform = body.platform.strip()[:60]
    username = body.username.strip()[:160]
    if not platform or not username:
        raise HTTPException(400, "平台名称与账号不能为空")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    item = {
        "id": "v_" + secrets.token_hex(6),
        "platform": platform,
        "site_url": body.site_url.strip()[:300],
        "username": username,
        "password_enc": _dpapi_encrypt(body.password) if body.password else "",
        "note": body.note.strip()[:300],
        "created_at": now,
        "updated_at": now,
    }
    items = _load_vault()
    items.insert(0, item)
    _save_vault(items)
    return {"ok": True, "item": _mask_item(item)}


@router.patch("/items/{item_id}", dependencies=[Depends(_require_local_only)])
def api_vault_update(item_id: str, body: VaultItemUpdate):
    items = _load_vault()
    target = next((x for x in items if x.get("id") == item_id), None)
    if not target:
        raise HTTPException(404, "账号记录不存在")

    if body.platform is not None and body.platform.strip():
        target["platform"] = body.platform.strip()[:60]
    if body.site_url is not None:
        target["site_url"] = body.site_url.strip()[:300]
    if body.username is not None and body.username.strip():
        target["username"] = body.username.strip()[:160]
    if body.clear_password:
        target["password_enc"] = ""
    elif body.password is not None and body.password != "":
        target["password_enc"] = _dpapi_encrypt(body.password)
    if body.note is not None:
        target["note"] = body.note.strip()[:300]
    target["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _save_vault(items)
    return {"ok": True, "item": _mask_item(target)}


@router.delete("/items/{item_id}", dependencies=[Depends(_require_local_only)])
def api_vault_delete(item_id: str):
    items = _load_vault()
    new_items = [x for x in items if x.get("id") != item_id]
    if len(new_items) == len(items):
        raise HTTPException(404, "账号记录不存在")
    _save_vault(new_items)
    return {"ok": True, "deleted_id": item_id}


@router.post("/items/{item_id}/reveal", dependencies=[Depends(_require_local_only)])
def api_vault_reveal(item_id: str):
    """按需单条解密返回密码（仅限用户主动点击查看或复制时触发）。"""
    items = _load_vault()
    target = next((x for x in items if x.get("id") == item_id), None)
    if not target:
        raise HTTPException(404, "账号记录不存在")
    enc = target.get("password_enc") or ""
    password = _dpapi_decrypt(enc) if enc else ""
    return {
        "ok": True,
        "id": item_id,
        "username": target.get("username") or "",
        "password": password,
    }
