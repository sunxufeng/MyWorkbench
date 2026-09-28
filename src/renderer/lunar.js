'use strict';
/**
 * 农历 / 二十四节气（公历 1900–2100）
 * 纯前端实现，无依赖。挂载到 window.Lunar。
 *
 * Lunar.solarToLunar(y, m, d) -> {
 *   year, month, day,        // 农历数值
 *   isLeap,                  // 是否闰月
 *   leapMonth,               // 当年闰月（0 表示无）
 *   yearCn, monthCn, dayCn,  // 中文名（含「闰」）
 *   zodiac, ganzhiYear,      // 生肖 / 干支年
 *   term                     // 当天若为节气则返回名，否则 null
 * }
 */

(function () {
  // 1900–2100 每年的农历信息位表（共 201 项）
  var lunarInfo = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0xc950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
    0x0d520,
  ];

  // 二十四节气偏差（1900–2100 近似，单位：分钟）
  var sTermInfo = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551,
    218072, 240693, 263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210,
    440795, 462224, 483532, 504758,
  ];

  var GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  var ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  var ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
  var MONTH_CN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  var TERM_CN = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];

  function lYearDays(y) {
    var sum = 348;
    for (var i = 0x8000; i > 0x8; i >>= 1) sum += lunarInfo[y - 1900] & i ? 1 : 0;
    return sum + leapDays(y);
  }
  function leapDays(y) {
    if (leapMonth(y)) return lunarInfo[y - 1900] & 0x10000 ? 30 : 29;
    return 0;
  }
  function leapMonth(y) {
    return lunarInfo[y - 1900] & 0xf;
  }
  function monthDays(y, m) {
    return lunarInfo[y - 1900] & (0x10000 >> m) ? 30 : 29;
  }

  function nStr1(n) {
    var s = ['日', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    if (n === 10) return '初十';
    if (n === 20) return '二十';
    if (n === 30) return '三十';
    if (n === 0) return '';
    var c = Math.floor(n / 10);
    var r = n % 10;
    if (c === 0) return '初' + s[r];
    if (c === 1) return '十' + s[r];
    if (c === 2) return '廿' + s[r];
    return '卅' + s[r];
  }

  /** 某年某节气落在当月的几号（n: 0..23） */
  function getTermDay(y, n) {
    var offDate = new Date(
      31556925974.7 * (y - 1900) + sTermInfo[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5)
    );
    return offDate.getUTCDate();
  }

  function solarToLunar(y, m, d) {
    if (y < 1900 || y > 2100) {
      return { error: '只支持 1900–2100' };
    }
    var base = Date.UTC(1900, 0, 31);
    var obj = Date.UTC(y, m - 1, d);
    var offset = Math.round((obj - base) / 86400000);

    var i, temp = 0, leap = 0, isLeap = false;
    for (i = 1900; i < 2101 && offset > 0; i++) {
      temp = lYearDays(i);
      offset -= temp;
    }
    if (offset < 0) {
      offset += temp;
      i--;
    }
    var year = i;
    leap = leapMonth(year);
    isLeap = false;
    for (i = 1; i < 13 && offset > 0; i++) {
      if (leap > 0 && i === leap + 1 && !isLeap) {
        i--;
        isLeap = true;
        temp = leapDays(year);
      } else {
        temp = monthDays(year, i);
      }
      if (isLeap && i === leap + 1) isLeap = false;
      offset -= temp;
    }
    if (offset === 0 && leap > 0 && i === leap + 1) {
      if (isLeap) isLeap = false;
      else {
        isLeap = true;
        i--;
      }
    }
    if (offset < 0) {
      offset += temp;
      i--;
    }
    var month = i;
    var day = offset + 1;

    var gzYear = year - 4; // 甲子轮
    var monthCn = (isLeap ? '闰' : '') + MONTH_CN[month - 1] + '月';

    // 节气：检查本月两个节气与下月第一个是否落在今天
    var term = null;
    var t1 = getTermDay(year, (m - 1) * 2);
    var t2 = getTermDay(year, (m - 1) * 2 + 1);
    var t3 = getTermDay(year, m * 2);
    if (d === t1) term = TERM_CN[(m - 1) * 2];
    else if (d === t2) term = TERM_CN[(m - 1) * 2 + 1];
    else if (d === t3 && m === 12) term = TERM_CN[23];

    return {
      year: year,
      month: month,
      day: day,
      isLeap: isLeap,
      leapMonth: leap,
      yearCn: (GAN[gzYear % 10] + ZHI[gzYear % 12]) + '年',
      zodiac: ANIMALS[gzYear % 12],
      monthCn: monthCn,
      dayCn: nStr1(day),
      term: term,
      ganzhiYear: GAN[gzYear % 10] + ZHI[gzYear % 12],
    };
  }

  /** 简短农历串：八月十六 / 闰二月 · 初五 */
  function lunarShort(y, m, d) {
    var l = solarToLunar(y, m, d);
    if (l.error) return '';
    return l.monthCn.replace('月', '') + '月 · ' + l.dayCn;
  }

  window.Lunar = { solarToLunar: solarToLunar, lunarShort: lunarShort };
})();
