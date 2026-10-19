from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..config import get_settings
from ..security import authenticate, create_token, current_user
from ..semantic.access import User
from ..services import get_services

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


def public_user(user: User) -> dict:
    s = get_services()
    return user.public(s.region_names(), s.store_names())


@router.post("/login")
def login(body: LoginIn) -> dict:
    user = authenticate(body.username, body.password)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")
    return {"token": create_token(user.username), "user": public_user(user)}


@router.get("/me")
def me(user: User = Depends(current_user)) -> dict:
    return public_user(user)


@router.get("/demo-users")
def demo_users() -> dict:
    """Identities listed on the login page (only when PROOFBI_DEMO=1)."""
    if not get_settings().demo:
        return {"users": [], "password": None}
    access = get_services().access
    return {"users": [public_user(u) for u in access.users.values()], "password": access.demo_password}
