{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  name = "pi-extensions-dev";
  
  buildInputs = with pkgs; [
    # Node.js for running extensions
    nodejs_20
    
    # Pi coding agent
    # Note: Adjust version/path as needed
    # pi
    
    # Development tools
    typescript
    nodePackages.typescript-language-server
    
    # Testing tools
    git
  ];
  
  shellHook = ''
    echo "🚀 Pi Extensions Development Shell"
    echo ""
    echo "Available commands:"
    echo "  node --version    - Check Node.js version"
    echo "  tsc --version     - Check TypeScript version"
    echo "  pi -e ./extensions/bash-permission/index.ts - Test extension"
    echo ""
    
    # Set up PATH for local node_modules if they exist
    if [ -d "node_modules/.bin" ]; then
      export PATH="$PWD/node_modules/.bin:$PATH"
    fi
  '';
}
