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
# Third: nix-env does not report a package's `version` attribute. It splits
# `name` at the first dash followed by a non-letter and calls the rest the
# version, and the importer drops anything that comes out empty. A package
# whose name carries no version (`gitwatch`, version 0.6) or a version that
# starts with a letter (`dotacat-v0.3.0`, `uefitool-A75`) was therefore
# never indexed, though `nix build nixpkgs#gitwatch` works. For top-level
# derivations whose name yields no version, the version attribute goes into
# `meta._devboxSearchVersion`, which the importer reads when nix-env's is
# empty. About a third have no version attribute either (`nix-info`,
# `appimage-run`, wrappers like `influxdb2`); those get the nixpkgs release
# (`26.11`), as nixpkgs does for its own unversioned tools (`lsb-release`).
# Only those ~200 derivations change; every other entry is byte-identical,
# so nothing already indexed churns.
#
# `--arg hiddenOnly true` lists just those derivations, for backfilling
# commits imported before this existed (`cli.js backfill`). Their entries
# are identical to the full eval's, at ~15 s and ~3 GB instead of minutes
# and ~15 GB.
{ config, system, hiddenOnly ? false }:
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
  # "" when nix-env can read a version from `name`, else the version
  # attribute, else the nixpkgs release. `version` is read only for those,
  # so the other ~25k derivations stay as lazy as before.
  hiddenVersion = drv:
    let
      r = builtins.tryEval (
        if (builtins.parseDrvName drv.name).version != "" then ""
        else if builtins.isString (drv.version or null) && drv.version != "" then drv.version
        else lib.trivial.release
      );
    in
    if r.success then r.value else "";
  visible = drv:
    let v = hiddenVersion drv;
    in drv // { _devboxSearchTopLevel = true; }
      // lib.optionalAttrs (v != "") { meta = (drv.meta or { }) // { _devboxSearchVersion = v; }; };
in
if hiddenOnly then
  lib.mapAttrs (_: visible)
    (lib.filterAttrs (_: drv: hiddenVersion drv != "") (removeAttrs topLevel pkgs._devboxSearchShims))
else
  removeAttrs
    (pkgs // lib.mapAttrs (_: visible) topLevel)
    (pkgs._devboxSearchShims ++ [ "_devboxSearchShims" ])
