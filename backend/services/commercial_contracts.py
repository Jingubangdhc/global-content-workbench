"""KOUBO-SKILL-P2 · 商业化架构预留契约（仅抽象接口与数据边界，本阶段不实现支付与会员系统）。

合规边界：
1. 不得将 Google AI Pro 个人会员共享给未来付费用户；
2. 不得将 CC BY-NC 4.0 模板、Overlay Studio 受限代码或 ChatCut 未经授权的服务作为对外收费产品运行依赖；
3. 正式商业上线前须取得商业许可或切换至独立原创替代方案。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SkillLicense:
    skill_id: str
    license_spdx: str
    commercial_allowed: bool
    attribution_required: bool
    restriction_note: str


@dataclass
class AssetLicense:
    asset_id: str
    source: str
    author: str
    license_note: str
    commercial_allowed: bool
    attribution_file: str = ""


@dataclass
class UsageMeter:
    job_id: str
    tenant_id: str = "local_owner"
    google_ai_pro_member: str = "个人官方客户端交互权益（剩余额度：未知；禁止对外共享）"
    model_visible_calls: int = 0
    chatcut_credits_used: float = 0.0
    extra_api_cost_usd: float = 0.0
    local_render_sec: float = 0.0


@dataclass
class Entitlement:
    tenant_id: str = "local_owner"
    plan_tier: str = "internal_personal"
    allow_chatcut_paid_credits: bool = False
    max_chatcut_credits_per_job: float = 0.0
    allow_external_paid_api: bool = False
    allowed_skills: list[str] = field(default_factory=lambda: [
        "premium-talk-edit",
        "whiteboard-koubo",
        "visual-director",
        "real-asset-director",
        "custom-motion-authoring",
        "video-quality-check",
    ])


@dataclass
class UserProjectIsolation:
    """多租户/项目级数据与文件隔离边界预留。"""
    tenant_id: str = "local_owner"
    project_id: int | None = None
    allowed_roots: list[str] = field(default_factory=list)

    def is_path_allowed(self, target_path: str) -> bool:
        from pathlib import Path
        resolved = str(Path(target_path).resolve()).lower()
        return any(resolved.startswith(str(Path(r).resolve()).lower()) for r in self.allowed_roots)


class EngineAdapter(ABC):
    """视频渲染与剪辑引擎抽象适配器（ChatCut Desktop / 未来独立 Remotion 等）。"""
    @abstractmethod
    def engine_id(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def health_check(self) -> dict[str, Any]:
        raise NotImplementedError


class AgentAdapter(ABC):
    """AI 导演执行代理抽象适配器（Google Antigravity 原生客户端 / 未来合规程序化代理）。"""
    @abstractmethod
    def agent_id(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def supports_programmatic_launch(self) -> bool:
        raise NotImplementedError
