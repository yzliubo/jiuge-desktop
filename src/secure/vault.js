'use strict';
// 单条加密 —— V2.1 ⑲。AES-256-GCM，只用 Node 内置 crypto，零第三方依赖。
//
// 【免责 · 必须随 UI 明示】忘记口令即不可恢复，且无任何后门：
//   密钥由口令经 scrypt 派生，口令既不存储、也不写进返回值、也不发往任何地方。
//   一旦丢失，密文永远解不开——本模块不提供找回、重置或万能口令。
//
// 派生参数 N=16384（scrypt 交互档，约几十毫秒，避免慢到卡 UI；不是抗离线暴力
//   破解的高成本档，用户需自行使用足够长的口令）。salt / iv 每次随机。

const crypto = require('crypto');

const VERSION = 1;
const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;          // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;           // GCM 推荐 96-bit IV
const TAG_LEN = 16;          // GCM 认证标签
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(passphrase, saltBuf) {
    return crypto.scryptSync(String(passphrase == null ? '' : passphrase), saltBuf, KEY_LEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM
    });
}

// encrypt(text, passphrase) → 可 JSON 序列化的 { v:1, salt, iv, tag, data }（均 base64）。
// 返回对象只含版本号与四段 base64，绝不含口令（也不含任何可反推口令的字段）。
function encrypt(text, passphrase) {
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const plain = String(text == null ? '' : text);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        v: VERSION,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64')
    };
}

// isEncrypted：形状检查。data 允许为空串（加密空文本时就是空串），故只校验类型不校验长度。
function isEncrypted(blob) {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false;
    if (blob.v !== VERSION) return false;
    const fields = ['salt', 'iv', 'tag', 'data'];
    for (let i = 0; i < fields.length; i += 1) {
        if (typeof blob[fields[i]] !== 'string') return false;
    }
    return true;
}

function decodeBlob(blob) {
    if (!isEncrypted(blob)) throw new Error('不是合法的密文对象（v1 需 salt/iv/tag/data 四个字符串）');
    const salt = Buffer.from(blob.salt, 'base64');
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const data = Buffer.from(blob.data, 'base64');
    if (salt.length !== SALT_LEN) throw new Error('salt 长度不对，数据可能被改');
    if (iv.length !== IV_LEN) throw new Error('iv 长度不对，数据可能被改');
    if (tag.length !== TAG_LEN) throw new Error('tag 长度不对，数据可能被改');
    return { salt: salt, iv: iv, tag: tag, data: data };
}

// decrypt(blob, passphrase) → 明文。口令错 / 数据被改，GCM 认证失败必须抛错。
// GCM 在 final() 才校验 tag：我们把明文攒在局部 Buffer 里，认证通过后才返回，
// 因此绝不返回「部分明文」。
function decrypt(blob, passphrase) {
    const b = decodeBlob(blob);
    const key = deriveKey(passphrase, b.salt);
    const decipher = crypto.createDecipheriv(ALGO, key, b.iv);
    decipher.setAuthTag(b.tag);
    const out = Buffer.concat([decipher.update(b.data), decipher.final()]);
    return out.toString('utf8');
}

// verify：只验口令是否正确，不返回明文（decrypt 的结果被丢弃，只留布尔）。
function verify(blob, passphrase) {
    try {
        decrypt(blob, passphrase);
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = {
    VERSION: VERSION,
    SCRYPT_N: SCRYPT_N,
    encrypt: encrypt,
    decrypt: decrypt,
    isEncrypted: isEncrypted,
    verify: verify
};
