import { expect, test } from "bun:test";
import { I18n, resolveLocale } from "../../../src/i18n/i18n.js";

test("auto-detects Chinese locale and interpolates messages", () => {
  expect(resolveLocale("auto", { LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
  expect(resolveLocale("auto", { LANG: "en_US.UTF-8" })).toBe("en");
  expect(new I18n("zh-CN").t("error.missingDependency", { dependency: "rclone" })).toBe(
    "缺少依赖：rclone",
  );
});
