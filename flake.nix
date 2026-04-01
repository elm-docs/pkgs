{
  description = "Elm development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js (python3 needed to compile better-sqlite3)
            nodejs_22
            python3
            zstd
            nodePackages.typescript
            nodePackages.typescript-language-server

            # Elm
            elmPackages.elm
            elmPackages.lamdera
            elmPackages.elm-format
            elmPackages.elm-json
            elmPackages.elm-test-rs
            elmPackages.elm-review

            # Elm language server
            elmPackages.elm-language-server
          ];
        };
      });
}
