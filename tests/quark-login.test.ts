import { describe, expect, test } from "vitest";
import {
  encodeB64Url,
  decodeB64Url,
  encodeSession,
  decodeSession,
  buildQrContent,
  domainScore,
  CAS_STATUS_OK,
  CAS_STATUS_FAIL,
  CookieJar,
  isRedirect,
  readSetCookies,
} from "~/lib/quark-login";

describe("encodeB64Url / decodeB64Url", () => {
  test("round-trip ASCII", () => {
    const raw = "token-abc-123";
    expect(decodeB64Url(encodeB64Url(raw))).toBe(raw);
  });

  test("round-trip UTF-8", () => {
    const raw = "夸克登录";
    expect(decodeB64Url(encodeB64Url(raw))).toBe(raw);
  });

  test("returns URL-safe chars", () => {
    const encoded = encodeB64Url("a+b/c=d");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });
});

describe("encodeSession / decodeSession", () => {
  const session = {
    token: "token-123",
    casCookie: "a=1; b=2",
    created: 1_234_567_890,
  };

  test("round-trip complete session", () => {
    const decoded = decodeSession(encodeSession(session));
    expect(decoded).toEqual(session);
  });

  test("decode invalid string returns null", () => {
    expect(decodeSession("!!!not-base64-url!!")).toBeNull();
  });

  test("decode missing token returns null", () => {
    expect(decodeSession(encodeB64Url(JSON.stringify({ c: "cookie" })))).toBeNull();
  });

  test("decode missing cookie defaults to empty string", () => {
    const raw = encodeB64Url(JSON.stringify({ t: "token" }));
    expect(decodeSession(raw)).toEqual({ token: "token", casCookie: "", created: 0 });
  });
});

describe("buildQrContent", () => {
  test("returns URL with token and client_id", () => {
    const url = buildQrContent("token-abc");
    expect(url).toContain("token=token-abc");
    expect(url).toContain("client_id=532");
    expect(url).toContain("ssb=weblogin");
  });
});

describe("domainScore", () => {
  test("base score is length", () => {
    expect(domainScore("abcd")).toBe(4);
  });

  test("contains drive adds 80", () => {
    expect(domainScore("drive.quark.cn")).toBeGreaterThanOrEqual(80);
  });

  test("contains pan.quark adds 40", () => {
    expect(domainScore("pan.quark.cn")).toBeGreaterThanOrEqual(40);
  });

  test("leading dot adds 5", () => {
    expect(domainScore(".quark.cn")).toBe(9 + 5);
  });
});

describe("CAS_STATUS_OK / CAS_STATUS_FAIL", () => {
  test("CAS_STATUS_OK equals 2000000", () => {
    expect(CAS_STATUS_OK).toBe(2000000);
  });

  test("CAS_STATUS_FAIL is a Set", () => {
    expect(CAS_STATUS_FAIL.has(50004002)).toBe(true);
    expect(CAS_STATUS_FAIL.has(50004005)).toBe(false);
  });
});

describe("isRedirect", () => {
  test.each([301, 302, 303, 307, 308])("detects %s as redirect", (status) => {
    expect(isRedirect(status)).toBe(true);
  });

  test("non-redirect status returns false", () => {
    expect(isRedirect(200)).toBe(false);
    expect(isRedirect(400)).toBe(false);
    expect(isRedirect(500)).toBe(false);
  });
});

describe("readSetCookies", () => {
  test("extracts multiple set-cookie headers", () => {
    const headers = new Headers([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(readSetCookies(headers)).toEqual(["a=1", "b=2"]);
  });

  test("falls back to single header", () => {
    const headers = new Headers({ "set-cookie": "a=1" });
    expect(readSetCookies(headers)).toEqual(["a=1"]);
  });

  test("empty headers returns empty array", () => {
    expect(readSetCookies(new Headers())).toEqual([]);
  });
});

describe("CookieJar", () => {
  test("stores and retrieves cookies", () => {
    const jar = new CookieJar();
    jar.absorb("uop.quark.cn", ["__pus=value1; Path=/", "csrf=value2; Path=/; Domain=.quark.cn"]);
    expect(jar.header()).toContain("__pus=value1");
    expect(jar.header()).toContain("csrf=value2");
  });

  test("skips telemetry cookies", () => {
    const jar = new CookieJar();
    jar.absorb("uop.quark.cn", ["_gid=abc; Path=/", "_ga=123; Path=/"]);
    expect(jar.header()).toBe("");
  });

  test("absorbPlain keeps plain name-value pairs as-is", () => {
    const jar = new CookieJar();
    jar.absorbPlain("a=1; b=2");
    expect(jar.header()).toBe("a=1; b=2");
  });

  test("isLoginCookie detects __pus", () => {
    const jar = new CookieJar();
    jar.absorbPlain("__pus=1");
    expect(jar.isLoginCookie()).toBe(true);
  });

  test("absorbPlain skips duplicates", () => {
    const jar = new CookieJar();
    jar.absorbPlain("a=first");
    jar.absorbPlain("a=second");
    expect(jar.header()).toBe("a=first");
  });
});
