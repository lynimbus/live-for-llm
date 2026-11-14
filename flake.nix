{
  description = "Decoupled AI companion with persistent memory, task harness, persistent browser control, and nsh GUI";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/ac9af266ee64ddb2eafeb4b250cac6a88147b43a";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
        config.android_sdk.accept_license = true;
      };
      nsh = pkgs.callPackage ./nix/nsh.nix { };
      nshAndroidSdk = pkgs.callPackage ./nix/nsh-android-sdk.nix { };
    in
    {
      packages.${system} = {
        inherit nsh;
        nsh-android-sdk = nshAndroidSdk;
        default = nsh;
      };

      devShells.${system} = {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nsh
            nodejs
            pnpm
            rustc
            cargo
            clippy
            rustfmt
            rust-analyzer
            pkg-config
            llvmPackages.clang
            sqlite
            beads
            just
          ];

          env = {
            LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };

          shellHook = ''
            export NSH_HOME="''${NSH_HOME:-$PWD/.nsh-home}"
            if [ -z "''${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ] && command -v chromium >/dev/null 2>&1; then
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)"
            fi
          '';
        };

        android = pkgs.mkShell {
          inputsFrom = [ self.devShells.${system}.default ];
          packages = with pkgs; [
            android-tools
            rustup
          ];
          env = {
            ANDROID_HOME = "${nshAndroidSdk.androidsdk}/libexec/android-sdk";
          };
        };
      };
    };
}
