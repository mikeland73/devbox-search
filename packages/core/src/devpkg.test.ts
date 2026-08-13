import { describe, expect, test } from "vitest";
import { canonicalName, canonicalNameEquals } from "./devpkg.js";

describe("canonicalName", () => {
  const cases: Array<[string, string]> = [
    // Grouped attribute paths.
    ["apacheHttpd", "apache"],
    ["apacheKafka", "apacheKafka"],
    ["apacheKafka_3_5", "apacheKafka"],
    ["gcc", "gcc"],
    ["gcc12", "gcc"],
    ["go", "go"],
    ["go_1_19", "go"],
    ["go_1_2", "go"],
    ["jdk", "jdk"],
    ["jdk17", "jdk"],
    ["jdk17_headless", "jdk-headless"],
    ["jre8", "jre"],
    ["jre8_headless", "jre-headless"],
    ["mariadb", "mariadb"],
    ["mariadb_1011", "mariadb"],
    ["mono6", "mono"],
    ["nixVersions.stable", "nix"],
    ["nixVersions.nix_2_17", "nix"],
    ["nodejs-18_x", "nodejs"],
    ["nodejs_20", "nodejs"],
    ["nodejs-slim-18_x", "nodejs-slim"],
    ["nodejs-slim_20", "nodejs-slim"],
    ["php81", "php"],
    ["python3", "python"],
    ["python311", "python"],
    ["python311Full", "python-full"],
    ["python39Minimal", "python-minimal"],
    ["ruby_3_1", "ruby"],
    ["tomcat10", "tomcat"],
    ["zulu17", "zulu"],

    // Attribute paths that must NOT be grouped.
    ["golangci-lint", "golangci-lint"],
    ["go-ethereum", "go-ethereum"],
    ["go_2_100", "go_2_100"], // 3-digit minor doesn't match ^go(_[0-9]_[0-9]{1,2})?$
    ["gcc-arm-embedded", "gcc-arm-embedded"],
    ["python3Packages.requests", "python3Packages.requests"],
    ["nodePackages.typescript", "nodePackages.typescript"],
    ["mariadb-connector-c", "mariadb-connector-c"],
    ["nixVersions", "nixVersions"], // requires a dot and suffix
    ["hello", "hello"],
  ];

  test.each(cases)("%s -> %s", (attrPath, want) => {
    expect(canonicalName(attrPath)).toBe(want);
  });
});

describe("canonicalNameEquals", () => {
  test("groups related attribute paths", () => {
    expect(canonicalNameEquals("go", "go_1_19")).toBe(true);
    expect(canonicalNameEquals("python3", "python311")).toBe(true);
    expect(canonicalNameEquals("go", "golangci-lint")).toBe(false);
  });
});
