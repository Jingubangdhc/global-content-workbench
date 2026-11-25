"""全局路径与环境变量配置管理。"""
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
SEED_DIR = ROOT_DIR / "seed"
DATA_DIR = ROOT_DIR / "data"
BACKUP_DIR = DATA_DIR / "backups"
TMP_AUDIO_DIR = DATA_DIR / "tmp_audio"
DB_PATH = DATA_DIR / "workbench.db"
ENV_PATH = ROOT_DIR / ".env"

for d in (DATA_DIR, BACKUP_DIR, TMP_AUDIO_DIR):
    d.mkdir(parents=True, exist_ok=True)

# 优先加载用户根目录下的 .env
if ENV_PATH.exists():
    load_dotenv(ENV_PATH, override=True)

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)


def get_env_config() -> dict:
    """读取当前环境变量配置（密钥只返回脱敏状态，不向前端暴露明文）。"""
    if ENV_PATH.exists():
        load_dotenv(ENV_PATH, override=True)
    llm_key = os.getenv("LLM_API_KEY", "").strip()
    tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
    yt_key = os.getenv("YOUTUBE_API_KEY", "").strip()
    douyin_api_base = os.getenv("DOUYIN_API_BASE", "").strip()
    return {
        "llm_base_url": os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1").strip(),
        "llm_model": os.getenv("LLM_MODEL", "deepseek-chat").strip(),
        "llm_configured": bool(llm_key),
        "llm_key_masked": f"{llm_key[:4]}****{llm_key[-4:]}" if len(llm_key) >= 8 else ("已配置" if llm_key else ""),
        "tavily_configured": bool(tavily_key),
        "youtube_api_configured": bool(yt_key),
        "douyin_api_base": douyin_api_base,
        "asr_engine": os.getenv("ASR_ENGINE", "whisper").strip(),
        "whisper_model_size": os.getenv("WHISPER_MODEL_SIZE", "small").strip(),
        "whisper_device": os.getenv("WHISPER_DEVICE", "auto").strip(),
    }


def save_env_keys(updates: dict) -> None:
    """将用户在设置页保存的配置安全写入本地 .env 文件。"""
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    kv = {}
    order = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        k = k.strip()
        kv[k] = v.strip()
        if k not in order:
            order.append(k)
    for k, v in updates.items():
        if v is None:
            continue
        kv[k] = str(v).strip()
        if k not in order:
            order.append(k)
    content = "# 本地工作台密钥与参数配置（请勿上传公开仓库）\n" + "\n".join(f"{k}={kv[k]}" for k in order) + "\n"
    ENV_PATH.write_text(content, encoding="utf-8")
    load_dotenv(ENV_PATH, override=True)
