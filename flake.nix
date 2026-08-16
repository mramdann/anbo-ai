{
  description = "Anbo - open-source lightweight cross-platform AI-native development environment";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "x86_64-darwin" "aarch64-darwin" ];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      anbo = pkgs.callPackage ./nix/package.nix { };
      default = self.packages.${system}.anbo;
    });

    nixosModules.anbo = { pkgs, ... }: {
      environment.systemPackages = [ self.packages.${pkgs.system}.anbo ];
    };

    darwinModules.anbo = { pkgs, ... }: {
      environment.systemPackages = [ self.packages.${pkgs.system}.anbo ];
    };
  };
}
