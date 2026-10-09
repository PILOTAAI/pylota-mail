/*
  Pylota Mail landing page: theme toggle, code tabs, copy buttons, small-screen menu.
  Progressive enhancement only. Without this file every code sample is shown, the
  theme follows the system setting, and the menu still opens.
*/
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  /* ---------- Theme: apply a saved choice before first paint ---------- */

  var STORAGE_KEY = 'pylota-mail-theme';

  function readTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (e) {
      return null;
    }
  }

  function writeTheme(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      /* Storage is blocked: the choice lasts for this page view only. */
    }
  }

  var saved = readTheme();
  if (saved) {
    root.setAttribute('data-theme', saved);
  }

  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function currentTheme() {
    var explicit = root.getAttribute('data-theme');
    if (explicit === 'light' || explicit === 'dark') {
      return explicit;
    }
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function initThemeToggle() {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    if (!buttons.length) {
      return;
    }

    function sync() {
      var pressed = currentTheme() === 'dark' ? 'true' : 'false';
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-pressed', pressed);
      }
    }

    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var next = currentTheme() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        writeTheme(next);
        sync();
      });
    }

    if (darkQuery) {
      var onSystemChange = function () {
        if (!root.hasAttribute('data-theme')) {
          sync();
        }
      };
      if (darkQuery.addEventListener) {
        darkQuery.addEventListener('change', onSystemChange);
      } else if (darkQuery.addListener) {
        darkQuery.addListener(onSystemChange);
      }
    }

    sync();
  }

  /* ---------- Tabs (WAI-ARIA tabs pattern, automatic activation) ---------- */

  function initTabs(container) {
    var panels = Array.prototype.slice.call(container.querySelectorAll('[data-tab-panel]'));
    if (panels.length < 2) {
      return;
    }

    var list = document.createElement('div');
    list.className = 'tablist';
    list.setAttribute('role', 'tablist');
    var label = container.getAttribute('data-tabs-label');
    if (label) {
      list.setAttribute('aria-label', label);
    }

    var tabs = panels.map(function (panel, index) {
      var heading = panel.querySelector('[data-tab-label]');
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.id = panel.id + '-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      tab.textContent = heading ? heading.textContent : 'Example ' + (index + 1);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      list.appendChild(tab);
      return tab;
    });

    function select(index, moveFocus) {
      tabs.forEach(function (tab, i) {
        var active = i === index;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        panels[i].hidden = !active;
      });
      if (moveFocus) {
        tabs[index].focus();
      }
    }

    list.addEventListener('click', function (event) {
      var tab = event.target.closest('[role="tab"]');
      if (tab) {
        select(tabs.indexOf(tab), false);
      }
    });

    list.addEventListener('keydown', function (event) {
      var current = tabs.indexOf(document.activeElement);
      if (current < 0) {
        return;
      }
      var last = tabs.length - 1;
      var next = null;
      switch (event.key) {
        case 'ArrowRight':
          next = current === last ? 0 : current + 1;
          break;
        case 'ArrowLeft':
          next = current === 0 ? last : current - 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        default:
          return;
      }
      event.preventDefault();
      select(next, true);
    });

    container.insertBefore(list, container.firstChild);
    select(0, false);
    container.classList.add('is-ready');
  }

  /* ---------- Copy buttons ---------- */

  var liveRegion = null;

  function announce(message) {
    if (!liveRegion) {
      liveRegion = document.createElement('p');
      liveRegion.className = 'visually-hidden';
      liveRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = '';
    window.setTimeout(function () {
      liveRegion.textContent = message;
    }, 50);
  }

  function legacyCopy(text) {
    var buffer = document.createElement('textarea');
    buffer.value = text;
    buffer.setAttribute('readonly', '');
    buffer.className = 'copy-buffer';
    document.body.appendChild(buffer);
    buffer.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(buffer);
    return ok;
  }

  function copyText(text) {
    var fallback = function () {
      return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
    };
    if (navigator.clipboard && window.isSecureContext) {
      /* The async API can be denied (permissions policy, embedded frames). */
      return navigator.clipboard.writeText(text).catch(fallback);
    }
    return fallback();
  }

  function selectContents(element) {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection) {
      return;
    }
    var range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function initCopyButtons() {
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-copy]');
      if (!button) {
        return;
      }
      var target = document.getElementById(button.getAttribute('data-copy'));
      if (!target) {
        return;
      }
      var labelEl = button.querySelector('.copy-label');
      var original = labelEl ? labelEl.textContent : '';
      copyText(target.textContent.trim()).then(
        function () {
          button.classList.add('is-copied');
          if (labelEl) {
            labelEl.textContent = 'Copied';
          }
          announce('Copied to clipboard');
          window.setTimeout(function () {
            button.classList.remove('is-copied');
            if (labelEl) {
              labelEl.textContent = original;
            }
          }, 1800);
        },
        function () {
          selectContents(target);
          announce('Could not copy automatically. The text is selected: press Control or Command and C.');
        }
      );
    });
  }

  /* ---------- Small-screen menu (a <details> element) ---------- */

  function initMobileNav() {
    var menu = document.querySelector('.nav-mobile');
    if (!menu) {
      return;
    }
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        menu.open = false;
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        var summary = menu.querySelector('summary');
        if (summary) {
          summary.focus();
        }
      }
    });
    document.addEventListener('click', function (event) {
      if (menu.open && !menu.contains(event.target)) {
        menu.open = false;
      }
    });
  }

  /* ---------- Primary navigation menus ----------
     Without JavaScript the menus open on hover and focus (CSS). Here they become
     disclosure buttons: click or Enter toggles, hover opens after a short delay,
     Escape closes and returns focus, and only one menu is open at a time. */

  function initMenus() {
    var items = Array.prototype.slice.call(document.querySelectorAll('[data-menu]'));
    if (!items.length) {
      return;
    }
    var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)');

    function setOpen(item, open) {
      var trigger = item.querySelector('.nav-trigger');
      if (open) {
        item.setAttribute('data-open', '');
      } else {
        item.removeAttribute('data-open');
      }
      if (trigger) {
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }

    function closeAll(except) {
      items.forEach(function (item) {
        if (item !== except) {
          setOpen(item, false);
        }
      });
    }

    items.forEach(function (item) {
      var trigger = item.querySelector('.nav-trigger');
      var timer = null;

      function schedule(open, delay) {
        window.clearTimeout(timer);
        timer = window.setTimeout(function () {
          if (open) {
            closeAll(item);
          }
          setOpen(item, open);
        }, delay);
      }

      trigger.addEventListener('click', function () {
        window.clearTimeout(timer);
        var open = !item.hasAttribute('data-open');
        closeAll(item);
        setOpen(item, open);
      });

      item.addEventListener('mouseenter', function () {
        if (finePointer && finePointer.matches) {
          schedule(true, 80);
        }
      });

      item.addEventListener('mouseleave', function () {
        if (finePointer && finePointer.matches) {
          schedule(false, 160);
        }
      });

      item.addEventListener('focusout', function (event) {
        if (!item.contains(event.relatedTarget)) {
          setOpen(item, false);
        }
      });

      item.addEventListener('click', function (event) {
        if (event.target.closest('a')) {
          setOpen(item, false);
        }
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') {
        return;
      }
      items.forEach(function (item) {
        if (item.hasAttribute('data-open')) {
          setOpen(item, false);
          var trigger = item.querySelector('.nav-trigger');
          if (trigger && item.contains(document.activeElement)) {
            trigger.focus();
          }
        }
      });
    });

    document.addEventListener('click', function (event) {
      if (!event.target.closest('[data-menu]')) {
        closeAll(null);
      }
    });
  }

  function init() {
    initThemeToggle();
    initMenus();
    var tabGroups = document.querySelectorAll('[data-tabs]');
    for (var i = 0; i < tabGroups.length; i++) {
      initTabs(tabGroups[i]);
    }
    initCopyButtons();
    initMobileNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
