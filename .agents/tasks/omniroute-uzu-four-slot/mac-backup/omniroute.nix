{ pkgs, username, ... }:
let
  home = "/Users/${username}";
  m5ModelCatalogEntries = builtins.toJSON [
    { id = "mlx-qwen3.8-27b-4bit"; name = "Qwen3.8 27B MLX 4-bit (M5 Max, 131K)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 131072; outputTokenLimit = 16384; supportsThinking = true; supportsVision = true; }
    # GLM is the dedicated spec/large-repository lane.  DS4 serves it at its
    # native 1M window on the M5 Max (--ctx 1048576, KV streamed from SSD); do
    # not let editor/provider metadata clamp it below that.
    { id = "ds4-glm53"; name = "GLM 5.3 Flash Q2 (M5 Max, 1M)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 1048576; outputTokenLimit = 16384; supportsThinking = true; supportsVision = true; }
    { id = "ds4-qwen-q4"; name = "Qwen 3.8 Flash Next Q4 (M5 Max)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 32768; outputTokenLimit = 16384; supportsThinking = true; supportsVision = true; }
    { id = "ds4-flash-quality"; name = "DeepSeek V4 Flash Q2/Q4 (M5 Max)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 32768; outputTokenLimit = 16384; supportsThinking = true; supportsVision = false; }
    { id = "ds4-deepseek-v41"; name = "DeepSeek V4.1 Flash Q2 SSD (M5 Max)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 32768; outputTokenLimit = 16384; supportsThinking = true; supportsVision = true; }
    { id = "ds4-deepseek-v41-uncensored"; name = "DeepSeek V4.1 Flash UNCENSORED Q2 (M5 Max, manual)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 245760; outputTokenLimit = 16384; supportsThinking = true; supportsVision = true; }
  ];
  esnixiModelCatalogEntries = builtins.toJSON [
    { id = "qwen3.8-27b-nvfp4"; name = "Qwen3.8 27B NVFP4 (RTX 5090)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 262144; outputTokenLimit = 16384; supportsThinking = true; }
    { id = "gemma-4-26b-a4b-nvfp4"; name = "Gemma 4 26B A4B NVFP4 (RTX 5090)"; source = "manual"; apiFormat = "chat-completions"; supportedEndpoints = [ "chat" ]; inputTokenLimit = 262144; outputTokenLimit = 16384; supportsThinking = true; }
  ];
  gremlinModelCatalogEntry = builtins.toJSON {
    id = "ornith-1.5:9b-262k";
    name = "Ornith 1.5 9B (RTX 4070 Ti Super, 262K)";
    source = "manual";
    apiFormat = "chat-completions";
    supportedEndpoints = [ "chat" ];
    inputTokenLimit = 262144;
    outputTokenLimit = 8192;
    supportsThinking = true;
  };
  omniRouteBootstrap = pkgs.writeText "omniroute-bootstrap.sql" ''
    INSERT OR REPLACE INTO key_value(namespace, key, value)
    VALUES('settings', 'requireLogin', 'false');

    INSERT OR REPLACE INTO key_value(namespace, key, value)
    VALUES('customModels', 'llama-cpp', '${m5ModelCatalogEntries}');

    INSERT OR REPLACE INTO key_value(namespace, key, value)
    SELECT
      'syncedAvailableModels',
      'llama-cpp:' || id,
      json('${m5ModelCatalogEntries}')
    FROM provider_connections
    WHERE provider = 'llama-cpp'
      AND name = 'stabulous-m5max';

    UPDATE provider_connections
    SET provider_specific_data = json_set(
      COALESCE(provider_specific_data, '{}'),
      '$.timeoutMs', 2400000,
      '$.baseUrl', 'http://127.0.0.1:7777/v1'
    )
    WHERE provider = 'llama-cpp'
      AND name = 'stabulous-m5max';

    INSERT OR REPLACE INTO key_value(namespace, key, value)
    SELECT
      'syncedAvailableModels',
      'vllm:' || id,
      json('${esnixiModelCatalogEntries}')
    FROM provider_connections
    WHERE provider = 'vllm'
      AND name = 'esnixi-5090';

    UPDATE provider_connections
    SET provider_specific_data = json_set(
      COALESCE(provider_specific_data, '{}'),
      '$.baseUrl', 'http://192.168.42.254:2701/v1'
    )
    WHERE provider = 'vllm'
      AND name = 'esnixi-5090';

    INSERT OR REPLACE INTO key_value(namespace, key, value)
    SELECT
      'syncedAvailableModels',
      'ollama-local:' || id,
      json_array(json('${gremlinModelCatalogEntry}'))
    FROM provider_connections
    WHERE provider = 'ollama-local'
      AND name = 'gremlin-4070ti-ollama';
  '';
  omniRoute = pkgs.writeShellScript "omniroute-server" ''
    set -euo pipefail
    mkdir -p "${home}/ai/logs" "${home}/.omniroute"

    # OmniRoute's dashboard login setting also gates /v1/models independently
    # of REQUIRE_API_KEY. This instance is loopback-only and is consumed by
    # Kiro, so keep both client API and model discovery local-keyless.
    if [[ -f "${home}/.omniroute/storage.sqlite" ]]; then
      ${pkgs.sqlite}/bin/sqlite3 "${home}/.omniroute/storage.sqlite" \
        ".read ${omniRouteBootstrap}"
    fi

    exec "${home}/ai/omniroute/node_modules/.bin/omniroute" serve \
      --port 20128 \
      --no-open \
      --no-tray \
      --no-recovery
  '';
in
{
  launchd.user.agents."com.celes.omniroute" = {
    command = "${omniRoute}";
    serviceConfig = {
      Label = "com.celes.omniroute";
      RunAtLoad = true;
      KeepAlive = true;
      ThrottleInterval = 10;
      StandardOutPath = "${home}/ai/logs/omniroute.log";
      StandardErrorPath = "${home}/ai/logs/omniroute.log";
      EnvironmentVariables = {
        HOME = home;
        PATH = "${pkgs.nodejs}/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        OMNIROUTE_DATA_DIR = "${home}/.omniroute";
        OMNIROUTE_SERVER_HOST = "127.0.0.1";
        # Qwen's vLLM and MLX chat templates accept one system message, but
        # require it to precede every user/assistant turn. Codex's Responses
        # payload can contain several developer instructions, so ask
        # OmniRoute to merge and hoist them before forwarding locally.
        OMNIROUTE_STRICT_SYSTEM_PROVIDERS = "vllm,llama-cpp";
        RATE_LIMIT_MAX_WAIT_MS = "300000";
        # Covers a full 5-minute model queue, cold start, and the long
        # time-to-first-byte of a GLM-5.3 1M-context prefill (KV from SSD).
        # Streaming thereafter is governed by the provider timeout and Zoo's
        # larger outer request budget.
        OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = "1200000";
        REQUIRE_API_KEY = "false";
      };
      ExitTimeOut = 30;
    };
  };
}
