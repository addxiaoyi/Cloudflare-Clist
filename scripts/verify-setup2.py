"""验证 /setup 向导完整交互（含新增校验逻辑）"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5174/setup"
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS" if cond else "FAIL") + f" | {name}" + (f" | {detail}" if detail else ""))

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path="/root/.cache/puppeteer/chrome-headless-shell/linux-151.0.7922.71/chrome-headless-shell-linux64/chrome-headless-shell",
    )
    page = browser.new_page()
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    check("页面渲染", page.locator("h1:has-text('项目初始化向导')").count() > 0)

    # 1. 空表单：管理员可留空（CI 自动生成）→ 下一步可用
    next_btn = page.locator("button:has-text('下一步')")
    check("空表单下一步可用（管理员可自动生成）", not next_btn.is_disabled())

    # 2. 只填用户名未填密码，仍禁用
    page.fill("input[placeholder='CList']", "测试站点")
    page.fill("input[placeholder='admin']", "admin")
    check("仅填用户名未填密码禁用", next_btn.is_disabled())

    # 2b. 密码过短，仍禁用
    page.fill("input[placeholder='至少 6 位']", "123")
    check("短密码仍禁用", next_btn.is_disabled())

    # 3. 密码够长后启用
    page.fill("input[placeholder='至少 6 位']", "test123456")
    check("填齐后下一步可用", not next_btn.is_disabled())

    # 4. Cloudflare 步骤：Account ID 可留空（CI 自动推导），但填了必须合法
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    check("AccountID 留空可用（CI 自动推导）", not next_btn.is_disabled())
    page.fill("input[placeholder='可选，粘贴 Account ID']", "test-account-id")
    check("AccountID 非 32 位十六进制禁用", next_btn.is_disabled())
    page.fill("input[placeholder='可选，粘贴 Account ID']", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
    check("AccountID 合法后可用", not next_btn.is_disabled())

    # 4b. Worker 名与兼容日期格式校验（Cloudflare 步骤输入顺序：API Token / Account ID / Worker 名称 / 兼容日期）
    step_inputs = page.locator("input")
    worker_input = step_inputs.nth(2)
    date_input = step_inputs.nth(3)
    page.fill("input[placeholder='可选，粘贴 Account ID']", "test-account-id")
    check("非法 AccountID 恢复禁用", next_btn.is_disabled())
    page.fill("input[placeholder='可选，粘贴 Account ID']", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
    worker_input.fill("bad_name!!")
    check("Worker 名非法禁用", next_btn.is_disabled())
    worker_input.fill("clist")
    date_input.fill("2025/04/04")
    check("兼容日期格式非法禁用", next_btn.is_disabled())
    date_input.fill("2025-04-04")
    check("兼容日期修正后可用", not next_btn.is_disabled())

    # 5. D1、R2（开 R2 但桶名为空则禁用）
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    page.click("button:has-text('启用 R2 桶')")
    page.wait_for_timeout(200)
    # 清空默认桶名验证必填（R2 步骤输入顺序：桶名 / Binding 名称）
    r2_bucket = page.locator("input").first
    r2_bucket.fill("")
    check("R2 桶名为空禁用", next_btn.is_disabled())
    r2_bucket.fill("test-bucket")
    check("R2 桶名填后可用", not next_btn.is_disabled())

    # 6. GDrive 步骤：开启后回调地址必填
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    page.click("button:has-text('启用 Google Drive')")
    page.wait_for_timeout(200)
    page.fill("input[placeholder='xxx.apps.googleusercontent.com']", "client-id.apps.googleusercontent.com")
    page.fill("input[type='password']", "client-secret")
    check("GDrive 回调为空禁用", next_btn.is_disabled())
    page.fill("input[placeholder='https://<worker域名>/api/gdrive-oauth']", "not-a-url")
    check("GDrive 回调非法 URL 禁用", next_btn.is_disabled())
    page.fill("input[placeholder='https://<worker域名>/api/gdrive-oauth']", "https://clist.workers.dev/api/gdrive-oauth")
    check("GDrive 回调填后可用", not next_btn.is_disabled())

    # 7. WebDAV 步骤：开启后密码必填
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    page.click("button:has-text('启用 WebDAV')")
    page.wait_for_timeout(200)
    check("WebDAV 密码为空禁用", next_btn.is_disabled())
    page.fill("input[type='password']", "webdav-pass")
    check("WebDAV 密码填后可用", not next_btn.is_disabled())

    # 8. GitHub 步骤（可选）→ 填入仓库验证 gh 命令生成
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    page.fill("input[placeholder='你的 GitHub 用户名']", "addxiaoyi")
    page.fill("input[placeholder='repo-name']", "Cloudflare-Clist")
    check("GitHub 步骤可继续", not next_btn.is_disabled())
    page.click("button:has-text('下一步')")
    page.wait_for_timeout(200)
    check("进入生成配置", page.locator("h2:has-text('生成配置')").count() > 0)

    # 9. 校验生成内容
    pre_text = page.locator("pre").all_inner_texts()
    json_t = pre_text[0] if pre_text else ""
    cmd_t = pre_text[1] if len(pre_text) > 1 else ""
    check("wrangler.jsonc 含 R2", "r2_buckets" in json_t and "test-bucket" in json_t)
    check("wrangler.jsonc 含 GDrive vars", "GOOGLE_CLIENT_ID" in json_t and "GOOGLE_REDIRECT_URI" in json_t)
    check("命令含 GDrive secret 单条", "GOOGLE_CLIENT_SECRET" in cmd_t and "secret put GOOGLE_CLIENT_ID" not in cmd_t)
    check("命令含 WebDAV 凭据", "WEBDAV_USERNAME" in cmd_t and "WEBDAV_PASSWORD" in cmd_t)
    check("命令含 gh WebDAV secrets", "gh secret set WEBDAV_USERNAME" in cmd_t and "gh secret set WEBDAV_PASSWORD" in cmd_t)
    check("命令含 gh R2 variable", "gh variable set R2_BUCKET_NAME" in cmd_t)
    check("gh 命令仅需 API_TOKEN", "gh secret set CLOUDFLARE_API_TOKEN" in cmd_t and "gh secret set CLOUDFLARE_ACCOUNT_ID" not in cmd_t)
    check("命令不含重复 GDrive 回调 secret", "secret put GOOGLE_REDIRECT_URI" not in cmd_t)

    # 10. 完整校验通过后无警告
    check("配置完整无警告", page.locator("text=配置完整").count() > 0)

    # 11. 重置清空草稿
    page.once("dialog", lambda d: d.accept())
    page.click("button:has-text('重置')")
    page.wait_for_timeout(400)
    check("重置回到第一步", page.locator("h2:has-text('站点与管理员账号')").count() > 0)
    check("重置后表单清空", page.input_value("input[placeholder='admin']") == "")

    # 过滤 HMR websocket 在 headless 下的正常断连，只看 JS 错误
    js_errors = [e for e in console_errors if "ERR_CONNECTION" not in e]
    check("控制台无 JS 错误", len(js_errors) == 0, f"errors={js_errors[:3]}")
    browser.close()

fails = [r for r in results if not r[1]]
print("\n==== 汇总 ====")
print(f"通过 {len(results)-len(fails)}/{len(results)}")
if fails:
    print("失败项:")
    for f in fails:
        print(" -", f[0], "|", f[2])
    sys.exit(1)
