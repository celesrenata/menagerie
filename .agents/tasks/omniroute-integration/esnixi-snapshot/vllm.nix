{ config, lib, pkgs, pkgsAccel, ... }:

let
  cuda13Packages = pkgs.cudaPackages_13_3.overrideScope (_: previous: {
    cccl = previous.cccl.overrideAttrs (old: {
      # CUDA 13.3 already contains this nixpkgs fix; reapplying it fails.
      patches = lib.filter (patch: !(lib.hasInfix "fix-invalid-cpp-syntax" (toString patch))) (old.patches or [ ]);
    });
  });
  cuda13Toolkit = pkgs.symlinkJoin {
    name = "cuda13.3-toolkit-runtime";
    paths = [
      cuda13Packages.cuda_nvcc
      cuda13Packages.cuda_cudart
      cuda13Packages.libcublas.include
      cuda13Packages.libcublas.lib
      pkgs.cudaPackages.cudatoolkit
    ];
    postBuild = ''
      # Nix's CUDA nvcc package keeps crt headers under bin/crt, while
      # cuda_runtime.h includes them as include-relative crt/*. Expose the
      # expected toolkit layout for FlashInfer's runtime JIT builds.
      mkdir -p "$out/include"
      ln -s ${pkgs.cudaPackages.cudatoolkit}/include/crt "$out/include/crt"
      for header in ${pkgs.cudaPackages.cudatoolkit}/include/curand*; do
        ln -sfn "$header" "$out/include/$(basename "$header")"
      done
      ln -s "$out/lib" "$out/lib64"
      ln -sf ${pkgs.cudaPackages.cudatoolkit}/lib/stubs/libcuda.so "$out/lib/stubs/libcuda.so"
    '';
  };
  quackKernels = pkgs.python314Packages."quack-kernels";
  flashinferPython = lib.findFirst (p: lib.hasInfix "flashinfer-python" (p.name or "")) (throw "vLLM dependency set does not contain FlashInfer") pkgsAccel.vllm.requiredPythonModules;
  # FlashInfer 0.6.18 provides set_autotune_process_group in its current
  # flashinfer.autotuner package; the former compatibility copy is obsolete.
  vllmPythonPath = lib.concatStringsSep ":" ([ "${pynvmlShim}" "${pkgsAccel.vllm}/lib/python3.14/site-packages" "${pkgsAccel.python3Packages.torch}/lib/python3.14/site-packages" "${quackKernels}/lib/python3.14/site-packages" ] ++ (map (p: "${p}/lib/python3.14/site-packages") pkgsAccel.vllm.requiredPythonModules));
  # tvm-ffi C++ headers needed by flashinfer JIT compilation
  tvmFfiHeaders = pkgs.fetchFromGitHub {
    owner = "mlc-ai";
    repo = "tvm-ffi";
    rev = "583e4b73c11aa3257e7be862834b98f33c39a6dd";
    hash = "sha256-noVRm8ba5DEM1qAYP8FzHuGA+KFWlR9w2GBBRsj/zhA=";
    fetchSubmodules = true;
  };

  # Python shim for tvm_ffi module (flashinfer 0.6.4+ requires it)
  tvmFfiShim = pkgs.writeTextDir "tvm_ffi/__init__.py" ''
    """tvm_ffi shim for flashinfer JIT compatibility."""

    class _LibInfo:
        @staticmethod
        def find_include_path():
            return "${tvmFfiHeaders}/include"

        @staticmethod
        def find_dlpack_include_path():
            return "${tvmFfiHeaders}/3rdparty/dlpack/include"

    libinfo = _LibInfo()

    def register_func(name, func=None, override=False):
        if func: return func
        return lambda f: f

    def load_module(path):
        import ctypes
        return ctypes.CDLL(str(path))

    def get_global_func(name, allow_missing=False):
        return None
  '';

  pynvmlShim = pkgs.writeTextDir "pynvml/__init__.py" ''
    import ctypes

    _lib = ctypes.CDLL("libnvidia-ml.so.1")
    _lib.nvmlInit_v2.restype = ctypes.c_int
    _lib.nvmlShutdown.restype = ctypes.c_int
    _lib.nvmlDeviceGetCount_v2.argtypes = [ctypes.POINTER(ctypes.c_uint)]
    _lib.nvmlDeviceGetCount_v2.restype = ctypes.c_int

    def nvmlInit():
        return _lib.nvmlInit_v2()

    def nvmlShutdown():
        return _lib.nvmlShutdown()

    def nvmlDeviceGetCount():
        count = ctypes.c_uint()
        result = _lib.nvmlDeviceGetCount_v2(ctypes.byref(count))
        if result != 0:
            raise RuntimeError(f"NVML error {result}")
        return count.value
  '';

  vllmEnvironment = {
    VLLM_TARGET_DEVICE = "cuda";
    CUDA_VISIBLE_DEVICES = "0";
    HOME = "/var/lib/vllm";
    HF_TOKEN_PATH = "${config.sops.secrets.huggingface_token.path}";
    # We prefetch both snapshots; serving must not stall on Hub metadata checks.
    HF_HUB_OFFLINE = "1";
    TRANSFORMERS_OFFLINE = "1";
    PYTHONPATH = vllmPythonPath;
    CUDA_HOME = cuda13Toolkit;
    CUDA_TOOLKIT_PATH = cuda13Toolkit;
    CUDACXX = "${cuda13Toolkit}/bin/nvcc";
    CC = "${pkgs.gcc14}/bin/gcc";
    CXX = "${pkgs.gcc14}/bin/g++";
    LD_LIBRARY_PATH = "${pkgs.cudaPackages.cudatoolkit}/lib:${config.hardware.nvidia.package}/lib";
    LIBRARY_PATH = "${pkgs.cudaPackages.cudatoolkit}/lib:${pkgs.cudaPackages.cudatoolkit}/lib/stubs:${config.hardware.nvidia.package}/lib";
  };

  vllmPath = [
    pkgs.bash
    pkgs.gcc14
    pkgs.binutils
    pkgs.cudaPackages.cudatoolkit
    pkgs.ninja
  ];

  mkVllmService = { model, servedModel, extraArgs, gpuMemoryUtilization ? "0.79", maxModelLen ? "147456", maxNumSeqs ? "1", kvOffloadingSize ? null, wantedBy ? [ ], conflicts ? [ ] }:
    {
      description = "vLLM OpenAI-compatible API server (${servedModel})";
      after = [ "network.target" ];
      inherit wantedBy conflicts;
      environment = vllmEnvironment;
      path = vllmPath;
      serviceConfig = {
        Type = "simple";
        User = "vllm";
        Group = "vllm";
        ExecStart = "${pkgsAccel.vllm}/bin/vllm serve ${model} --served-model-name ${servedModel} --host 127.0.0.1 --port 8010 --max-model-len ${maxModelLen} --max-num-seqs ${maxNumSeqs} --gpu-memory-utilization ${gpuMemoryUtilization} --kv-cache-dtype nvfp4 ${lib.optionalString (kvOffloadingSize != null) "--kv-offloading-size ${toString kvOffloadingSize} --kv-offloading-backend native"} ${extraArgs}";
        Restart = "on-failure";
        RestartSec = "10s";
        TimeoutStopSec = "120s";
      };
    };

  switcherScript = pkgs.writeText "vllm-switch.py" (builtins.readFile ./vllm-switch.py);
in
{
  sops.secrets.huggingface_token = {
    sopsFile = ../secrets/secrets.yaml;
    owner = "vllm";
    group = "vllm";
  };

  systemd.services.vllm = mkVllmService {
    model = "nvidia/Qwen3.8-27B-NVFP4";
    servedModel = "qwen3.8-27b-nvfp4";
    # The built-in MTP head is substantially faster than DFlash2 on this
    # target while preserving the full production context.
    gpuMemoryUtilization = "0.88";
    maxModelLen = "147456";
    maxNumSeqs = "1";
    extraArgs = "--language-model-only --linear-backend cutlass --reasoning-parser qwen3 --tool-call-parser qwen3_xml --enable-auto-tool-choice --max-num-batched-tokens 256 --speculative-config '{\"method\":\"mtp\",\"num_speculative_tokens\":3}'";
  };

  sops.secrets.vllm_switcher_token = {
    sopsFile = ../secrets/secrets.yaml;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  users.users.vllm-switcher = {
    isSystemUser = true;
    group = "vllm-switcher";
  };
  users.groups.vllm-switcher = { };

  security.sudo.extraRules = [
    {
      users = [ "vllm-switcher" ];
      commands = [
        {
          command = "${pkgs.systemd}/bin/systemctl start vllm.service";
          options = [ "NOPASSWD" ];
        }
      ];
    }
  ];

  systemd.services.vllm-switcher = {
    description = "Authenticated automatic vLLM model switcher for the RTX 5090";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];
    environment = {
      SYSTEMCTL = "${pkgs.systemd}/bin/systemctl";
      SUDO = "/run/wrappers/bin/sudo";
    };
    serviceConfig = {
      Type = "simple";
      User = "vllm-switcher";
      Group = "vllm-switcher";
      ExecStart = "${pkgs.python3}/bin/python3 ${switcherScript}";
      LoadCredential = [ "bearer-token:${config.sops.secrets.vllm_switcher_token.path}" ];
      Restart = "always";
      RestartSec = "2s";
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    };
  };

  users.users.vllm = {
    isSystemUser = true;
    group = "vllm";
    home = "/var/lib/vllm";
    createHome = true;
  };

  users.groups.vllm = {};
}
