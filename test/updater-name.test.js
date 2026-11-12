'use strict';
/**
 * 升级后桌面上的 exe 名字要跟着版本走。
 * 早期发出去的包叫「物种标注工坊-0.6.20.exe」，只认 tagden 前缀时这个名字永远不改，
 * 用户看到的就是「更新完版本号没变」。这里把命名规则钉死。
 */

const test = require('node:test');
const assert = require('node:assert');
const { nextExeName } = require('../lib/updater');

test('中文名带版本号的 exe 会被改成新版本', () => {
  assert.equal(nextExeName('物种标注工坊-0.6.20.exe', '0.8.5'), '物种标注工坊-0.8.5.exe');
});

test('tagden 前缀同样跟着版本走', () => {
  assert.equal(nextExeName('tagden-0.8.4.exe', '0.8.5'), 'tagden-0.8.5.exe');
  assert.equal(nextExeName('tagden-v0.8.4.exe', '0.8.5'), 'tagden-0.8.5.exe');
});

test('不带版本号的自定义名字一律不动', () => {
  assert.equal(nextExeName('物种标注工坊.exe', '0.8.5'), '');
  assert.equal(nextExeName('tagden-win.exe', '0.8.5'), '');
  assert.equal(nextExeName('我的工具-0.8.4.exe', '0.8.5'), '');
});

test('已经是对应版本就不改名，避免自己改自己', () => {
  assert.equal(nextExeName('物种标注工坊-0.8.5.exe', '0.8.5'), '');
  assert.equal(nextExeName('tagden-0.8.5.exe', '0.8.5'), '');
});

test('版本号为空时返回空串（调用方据此跳过改名）', () => {
  assert.equal(nextExeName('物种标注工坊-0.6.20.exe', ''), '');
});
