"""Demo authentication: identities come from ``semantic/access.yaml``.

The token only carries the username; the data scope is looked up on every request, so
changing a user's scope in the policy file takes effect immediately. In production this
would be replaced by the company's SSO (for example WeCom OAuth); the rest of the system
only needs a ``User``.
"""

from __future__ import annotations

import hmac
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import get_settings
from .semantic.access import User
from .services import get_services

_bearer = HTTPBearer(auto_error=False)


def create_token(username: str) -> str:
    settings = get_settings()
    payload = {"sub": username, "exp": datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def authenticate(username: str, password: str) -> User | None:
    access = get_services().access
    user = access.users.get(username.strip().lower())
    if user is None or not access.demo_password:
        return None
    if not hmac.compare_digest(password.encode(), access.demo_password.encode()):
        return None
    return user


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "请先登录")
    try:
        payload = jwt.decode(credentials.credentials, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已过期，请重新登录") from None
    user = get_services().access.users.get(payload.get("sub", ""))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不存在")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "需要管理员权限")
    return user
