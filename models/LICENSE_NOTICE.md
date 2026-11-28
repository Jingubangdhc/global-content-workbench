# 本地免费翻译模型与推理引擎许可证声明

1. **腾讯混元 Hy-MT3-1.8B-GGUF**
   - 官方来源：<https://huggingface.co/tencent/Hy-MT3-1.8B-GGUF>
   - 许可证：**Apache License 2.0**
   - 说明：模型权重文件（`Hy-MT3-1.8B-Q4_K_M.gguf`，约 1.35 GB）由用户授权后下载至本地 `models/hunyuan-mt/` 目录，已加入 `.gitignore`，不随源码提交至 Git 仓库。

2. **llama.cpp（CUDA 12.4 Windows 便携版 `b12823`）**
   - 官方来源：<https://github.com/ggml-org/llama.cpp>
   - 许可证：**MIT License**
   - 说明：推理可执行文件与 CUDA 运行库部署在 `runtime/llama-cpp/`，已加入 `.gitignore`，仅监听本机回环地址 `127.0.0.1:8081`。
