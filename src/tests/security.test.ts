import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. accountId path traversal validation
// ---------------------------------------------------------------------------

// Re-implement the validation logic here since the original is not exported
function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

describe('validateAccountId — path traversal prevention', () => {
  it('accepts normal alphanumeric IDs', () => {
    assert.doesNotThrow(() => validateAccountId('bot-123'));
    assert.doesNotThrow(() => validateAccountId('abc_DEF_456'));
    assert.doesNotThrow(() => validateAccountId('simple'));
  });

  it('rejects path traversal patterns', () => {
    assert.throws(() => validateAccountId('../../../etc/passwd'), /Invalid accountId/);
    assert.throws(() => validateAccountId('..'), /Invalid accountId/);
    assert.throws(() => validateAccountId('foo/../bar'), /Invalid accountId/);
  });

  it('rejects slashes', () => {
    assert.throws(() => validateAccountId('foo/bar'), /Invalid accountId/);
    assert.throws(() => validateAccountId('/etc/passwd'), /Invalid accountId/);
  });

  it('rejects empty string', () => {
    assert.throws(() => validateAccountId(''), /Invalid accountId/);
  });

  it('rejects special characters', () => {
    assert.throws(() => validateAccountId('id with spaces'), /Invalid accountId/);
    assert.throws(() => validateAccountId('id;rm -rf'), /Invalid accountId/);
    assert.throws(() => validateAccountId('id\x00null'), /Invalid accountId/);
  });
});

// ---------------------------------------------------------------------------
// 2. baseUrl SSRF domain whitelist
// ---------------------------------------------------------------------------

function validateBaseUrl(baseUrl: string): void {
  if (
    !baseUrl.startsWith('https://') ||
    !/(?:^|\.)(?:weixin\.qq\.com|wechat\.com)(\/|$)/.test(baseUrl.slice('https://'.length))
  ) {
    throw new Error(`Untrusted baseUrl: "${baseUrl}"`);
  }
}

describe('baseUrl SSRF whitelist', () => {
  it('accepts valid weixin.qq.com URLs', () => {
    assert.doesNotThrow(() => validateBaseUrl('https://weixin.qq.com'));
    assert.doesNotThrow(() => validateBaseUrl('https://ilinkai.weixin.qq.com'));
    assert.doesNotThrow(() => validateBaseUrl('https://sub.weixin.qq.com/'));
  });

  it('accepts valid wechat.com URLs', () => {
    assert.doesNotThrow(() => validateBaseUrl('https://wechat.com'));
    assert.doesNotThrow(() => validateBaseUrl('https://api.wechat.com'));
  });

  it('rejects non-https', () => {
    assert.throws(() => validateBaseUrl('http://weixin.qq.com'), /Untrusted baseUrl/);
  });

  it('rejects untrusted domains', () => {
    assert.throws(() => validateBaseUrl('https://evil.com'), /Untrusted baseUrl/);
    assert.throws(() => validateBaseUrl('https://evil.com?x=weixin.qq.com'), /Untrusted baseUrl/);
    assert.throws(() => validateBaseUrl('https://notweixin.qq.com.evil.com'), /Untrusted baseUrl/);
  });

  it('rejects fake subdomains', () => {
    assert.throws(() => validateBaseUrl('https://weixin.qq.com.evil.com'), /Untrusted baseUrl/);
  });
});

// ---------------------------------------------------------------------------
// 3. CDN query param injection prevention
// ---------------------------------------------------------------------------

function validateCdnQueryParam(encryptQueryParam: string): void {
  if (!/^[A-Za-z0-9%=&+._~-]+$/.test(encryptQueryParam)) {
    throw new Error('Invalid CDN query parameter');
  }
}

describe('CDN query param injection', () => {
  it('accepts normal URL-safe query params', () => {
    assert.doesNotThrow(() => validateCdnQueryParam('key=abc123&token=xyz'));
    assert.doesNotThrow(() => validateCdnQueryParam('enc%3Dvalue'));
    assert.doesNotThrow(() => validateCdnQueryParam('a=1&b=2&c=3'));
  });

  it('rejects characters that could break out of query string', () => {
    assert.throws(() => validateCdnQueryParam('key=val\nHost: evil'), /Invalid CDN/);
    assert.throws(() => validateCdnQueryParam('key=val;drop table'), /Invalid CDN/);
    assert.throws(() => validateCdnQueryParam('<script>'), /Invalid CDN/);
  });

  it('rejects empty string', () => {
    assert.throws(() => validateCdnQueryParam(''), /Invalid CDN/);
  });
});
