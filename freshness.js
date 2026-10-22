// freshness.js — közös elavultság-számítás az index.html-nek és a brief.html-nek.
//
// A backend forrásonként bélyegzi (d.freshness), mikor jött utoljára érdemi adat.
// Ami a MOSTANI időhöz képest 24 óránál régebbi, az régi; 3 naptól piros.
// B9: a régi kód a payload saját synced_at-jéhez mért. Egy teljesen leállt
// pipeline-ban minden bélyeg egyformán régi, tehát semmi nem látszott régebbinek,
// és nem volt figyelmeztetés — pont akkor, amikor a legnagyobb szükség lett volna rá.
//
// A bemenet a deepEscape-elt payload: a nevek és a bélyegek már semlegesítve vannak.
// A bélyegek helyi idők ("YYYY-MM-DD HH:MM"), és a böngésző is helyi időként olvassa.
var HealthFreshness = (function () {
  'use strict';
  var STALE_AFTER_MS = 24 * 3600 * 1000;
  var NEV = {garmin: 'recovery', hevy: 'training', calendar: 'calendar',
             weather: 'weather', body_comp: 'body composition'};
  function stale(freshness, nowMs) {
    var fr = freshness || {};
    return Object.keys(fr).map(function (k) {
      return {key: k, t: Date.parse(String(fr[k]).replace(' ', 'T')), when: fr[k]};
    }).filter(function (x) {
      return !isNaN(x.t) && nowMs - x.t > STALE_AFTER_MS;
    }).map(function (x) {
      return {name: NEV[x.key] || x.key, days: Math.floor((nowMs - x.t) / 86400000), when: x.when};
    });
  }
  return {stale: stale, RED_DAYS: 3};
})();
