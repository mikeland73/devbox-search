# The expression nix-env evaluates. It is nixpkgs, with three adjustments.
#
# nix-env lists each derivation once: it walks attributes in lexicographic
# order, recursing into sets that ask for it, and skips any attribute set it
# has already listed. A top-level package that some earlier-visited nested
# attribute aliases is therefore reported under the nested name only —
# `buildbotPackages.python` is `python314`, and `b` < `p`, so `python314`
# itself vanished from the output the day that alias appeared (#49).
# `python3`, `jre` and about a thousand other top-level names are hidden
# the same way, by whichever alias sorts first.
#
# Top-level names are the ones people install by, so every top-level
# derivation is given a fresh attribute set here (`//` with a non-empty
# right-hand side — an empty one is optimised away): nix-env has not seen
# that set before and lists it under its own name. Nested aliases still list
# too; the consumer already treats several attribute paths per store path as
# normal. Everything else — meta, outputs, the config — is untouched, and
# the entries that were already listed come out byte-identical.
#
# Cost: the ~25k top-level attributes are forced up front rather than on the
# way (nix-env forces all of them anyway), plus one shallow copy each.
#
# Second: nixpkgs sometimes turns a package into an alias while other
# nixpkgs code still refers to it by the old name. packages-config.nix turns
# aliases off, so that reference is a missing attribute: an error nix-env
# cannot skip, which aborts the whole eval. Upstream's own search eval never
# gets that far, because its unfree check throws first; we allow unfree.
# Hit when `cudatoolkit` became an alias (nixpkgs#565306, 2026-09-20) while
# haskellPackages.{cuda,cufft,nvvm} still read `pkgs.cudatoolkit`. Each shim
# puts the attribute back only where nixpkgs lacks it, and the output drops
# it again so it is listed exactly as often as the alias would be: never.
# Drop a shim once nixpkgs stops referring to the old name.
#
# Third: a few attribute paths people install by that nix-env cannot reach.
# `stdenv.cc.cc.lib` (libstdc++, for prebuilt binaries such as Python wheels)
# sits inside a derivation, and nix-env never descends into one. Nor can the
# path simply be an attribute name: nix-env skips any name outside
# [A-Za-z_][A-Za-z0-9-_+]*, so a name with a dot is silently dropped. Each
# path is listed under _devboxSearchAttrPaths instead, carrying its real
# path in meta._devboxSearchAttrPath, which the importer uses in place of the
# listed one. A path naming one output (`.lib`) installs only that output
# (`nix profile install …#stdenv.cc.cc.lib`), so its outputsToInstall says so
# rather than inheriting the package's `out` and `man`. A path a system
# lacks is left out on that system.
{ config, system }:
let
  shims = pkgs: {
    cudatoolkit = pkgs.cudaPackages.cudatoolkit;
  };
  addShims = final: prev:
    let added = removeAttrs (shims final) (builtins.attrNames prev);
    in added // { _devboxSearchShims = builtins.attrNames added; };
  pkgs = import ./nixpkgs { inherit config system; overlays = [ addShims ]; };
  inherit (pkgs) lib;
  # tryEval catches the same errors nix-env ignores (assertion failures and
  # throws, e.g. a removed alias); anything else already aborted the eval.
  isDerivation = _: v: let r = builtins.tryEval (lib.isDerivation v); in r.success && r.value;
  topLevel = lib.filterAttrs isDerivation pkgs;
  attrPaths = [ "stdenv.cc" "stdenv.cc.cc" "stdenv.cc.cc.lib" "stdenv.cc.libc" ];
  listAttrPath = path:
    let drv = lib.attrByPath (lib.splitString "." path) null pkgs;
    in lib.optional (isDerivation path drv) {
      name = lib.replaceStrings [ "." ] [ "-" ] path;
      value = drv // {
        meta = (drv.meta or { }) // { _devboxSearchAttrPath = path; }
          // lib.optionalAttrs (drv.outputSpecified or false) { outputsToInstall = [ drv.outputName ]; };
      };
    };
in
removeAttrs
  (pkgs // lib.mapAttrs (_: drv: drv // { _devboxSearchTopLevel = true; }) topLevel // {
    _devboxSearchAttrPaths = lib.recurseIntoAttrs (lib.listToAttrs (lib.concatMap listAttrPath attrPaths));
  })
  (pkgs._devboxSearchShims ++ [ "_devboxSearchShims" ])
