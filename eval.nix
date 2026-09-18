# The expression nix-env evaluates. It is nixpkgs, with one adjustment.
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
{ config, system }:
let
  pkgs = import ./nixpkgs { inherit config system; };
  inherit (pkgs) lib;
  # tryEval catches the same errors nix-env ignores (assertion failures and
  # throws, e.g. a removed alias); anything else already aborted the eval.
  isDerivation = _: v: let r = builtins.tryEval (lib.isDerivation v); in r.success && r.value;
  topLevel = lib.filterAttrs isDerivation pkgs;
in
pkgs // lib.mapAttrs (_: drv: drv // { _devboxSearchTopLevel = true; }) topLevel
