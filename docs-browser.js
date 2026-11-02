// Animastor docs browser — lightweight, no-build, hash-routed.
// Renders the repository docs/ tree as navigable markdown pages.
(function () {
  'use strict';

  /* ── File tree: загружается из /docs/tree.json
     (генерируется scripts/deploy-docs.sh после rsync) ── */
  var TREE = null;

  /* ── Markdown → HTML (lightweight parser) ── */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Ссылки markdown: относительные пути переписываются в hash-маршруты
     docs-browser ('#/<путь>'), путь разрешается относительно каталога
     ТЕКУЩЕГО документа. Внешние (http(s), mailto) и якоря — как есть. ── */
  function isExternalHref(href) {
    return /^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href);
  }

  // '#section' → {path:'', anchor:'#section'}; 'a/b#x' → {path:'a/b', anchor:'#x'}
  function splitHref(href) {
    var i = href.indexOf('#');
    return i < 0
      ? { path: href, anchor: '' }
      : { path: href.slice(0, i), anchor: href.slice(i) };
  }

  // '../a/./b' → 'a/b'; выход за корень (лишний '..') отбрасывается
  function normalizeDocPath(p) {
    var out = [];
    p.split('/').forEach(function (seg) {
      if (seg === '' || seg === '.') return;
      if (seg === '..') { out.pop(); return; }
      out.push(seg);
    });
    return out.join('/');
  }

  // Относительная ссылка → цель docs-browser.
  //  - каталог (заканчивается на '/' или последний сегмент без точки)
  //    и *.md → '#/<путь>';
  //  - прочие файлы (картинки и т.п.) → '/docs/<путь>';
  //  - ведущий 'docs/' (старые ссылки) отбрасывается;
  //  - якорь '#section' сохраняется в конце.
  function resolveDocLink(href, docPath) {
    var h = splitHref(href);
    if (!h.path) return href;            // только якорь — не трогаем
    var p = h.path;
    var fromRoot = false;               // путь от корня docs (после среза docs/)
    if (p === 'docs') { p = ''; fromRoot = true; }
    else if (p.indexOf('docs/') === 0) { p = p.slice(5); fromRoot = true; }
    if (!p) return '#/' + h.anchor;      // ссылка на корень docs
    var dir = fromRoot || !docPath
      ? ''
      : docPath.split('/').slice(0, -1).join('/');
    var full = normalizeDocPath(dir ? dir + '/' + p : p);
    if (!full) return '#/' + h.anchor;
    var last = full.split('/').pop();
    var isDir = p.charAt(p.length - 1) === '/' || last.indexOf('.') < 0;
    if (isDir || /\.md$/i.test(last)) return '#/' + full + h.anchor;
    return '/docs/' + full + h.anchor;
  }

  function renderMd(src, docPath) {
    var lines = src.split('\n');
    var html = [];
    var i = 0;
    var inCode = false;
    var inList = false;
    var listType = '';
    var prevEmpty = false;

    function closeList() {
      if (inList) { html.push(listType === 'ol' ? '</ol>' : '</ul>'); inList = false; }
    }

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code blocks
      if (/^```/.test(line)) {
        closeList();
        if (inCode) {
          html.push('</code></pre>');
          inCode = false;
        } else {
          var lang = line.slice(3).trim();
          html.push('<pre' + (lang ? ' class="lang-' + escapeHtml(lang) + '"' : '') + '><code>');
          inCode = true;
        }
        i++;
        continue;
      }
      if (inCode) {
        html.push(escapeHtml(line));
        i++;
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        closeList();
        prevEmpty = true;
        i++;
        continue;
      }

      // Headings
      var m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) {
        closeList();
        var level = m[1].length;
        html.push('<h' + level + '>' + inlineMd(m[2], docPath) + '</h' + level + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        html.push('<hr>');
        i++;
        continue;
      }

      // Unordered list
      m = line.match(/^(\s*)([-*+])\s+(.*)/);
      if (m) {
        if (!inList || listType !== 'ul') {
          closeList();
          html.push('<ul>');
          inList = true;
          listType = 'ul';
        }
        html.push('<li>' + inlineMd(m[3], docPath) + '</li>');
        i++;
        continue;
      }

      // Ordered list
      m = line.match(/^(\s*)\d+[.)]\s+(.*)/);
      if (m) {
        if (!inList || listType !== 'ol') {
          closeList();
          html.push('<ol>');
          inList = true;
          listType = 'ol';
        }
        html.push('<li>' + inlineMd(m[2], docPath) + '</li>');
        i++;
        continue;
      }

      // Table (simple: | col | col |)
      if (/^\|/.test(line) && /\|/.test(line)) {
        closeList();
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          var cells = lines[i].split('|').slice(1, -1).map(function (c) { return c.trim(); });
          rows.push(cells);
          i++;
        }
        if (rows.length > 0) {
          html.push('<table>');
          html.push('<thead><tr>');
          rows[0].forEach(function (c) { html.push('<th>' + inlineMd(c, docPath) + '</th>'); });
          html.push('</tr></thead>');
          if (rows.length > 2) {
            html.push('<tbody>');
            for (var r = 2; r < rows.length; r++) {
              html.push('<tr>');
              rows[r].forEach(function (c) { html.push('<td>' + inlineMd(c, docPath) + '</td>'); });
              html.push('</tr>');
            }
            html.push('</tbody>');
          }
          html.push('</table>');
        }
        continue;
      }

      // Paragraph
      closeList();
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\|[-*+]|\d+[.)]\s)/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        html.push('<p>' + inlineMd(para.join(' '), docPath) + '</p>');
      }
    }
    closeList();
    if (inCode) html.push('</code></pre>');
    return html.join('\n');
  }

  function inlineMd(s, docPath) {
    // Ссылки собираются в массив и подставляются ПОСЛЕ автоссылок на
    // http(s) — иначе regex автоссылок портил уже вставленный <a href>.
    var links = [];
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (all, text, href) {
        links.push(/^https?:/i.test(href)
          ? '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>'
          : '<a href="' + (isExternalHref(href) ? href : resolveDocLink(href, docPath)) +
            '">' + text + '</a>');
        return '\u0000' + (links.length - 1) + '\u0000';
      })
      .replace(/((https?:\/\/)[^\s<>")]+)/g, function (url) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
      })
      .replace(/\u0000(\d+)\u0000/g, function (all, idx) { return links[+idx]; });
  }

  /* ── Sidebar tree renderer ── */
  function renderTree(node, path, expanded) {
    var keys = Object.keys(node);
    keys.sort(function (a, b) {
      var aDir = typeof node[a] === 'object';
      var bDir = typeof node[b] === 'object';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    var ul = document.createElement('ul');
    keys.forEach(function (name) {
      var isDir = typeof node[name] === 'object';
      var full = path ? path + '/' + name : name;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#/' + full;
      a.className = isDir ? 'docs-tree-dir' : 'docs-tree-file';
      if (isDir) {
        var icon = document.createElement('span');
        icon.className = 'docs-tree-icon';
        icon.textContent = expanded[full] ? '\u25BC' : '\u25B6';
        a.appendChild(icon);
      }
      a.appendChild(document.createTextNode(name));
      li.appendChild(a);
      if (isDir && expanded[full]) {
        li.appendChild(renderTree(node[name], full, expanded));
      }
      ul.appendChild(li);
    });
    return ul;
  }

  /* ── App state ── */
  var contentEl = document.getElementById('docs-content');
  var treeEl = document.getElementById('docs-tree');
  var breadcrumbEl = document.getElementById('docs-breadcrumb');
  var toggleBtn = document.getElementById('docs-sidebar-toggle');
  var sidebarEl = document.querySelector('.docs-sidebar');
  var expandedDirs = {};
  var cache = {};

  function getHash() {
    var h = location.hash || '#/';
    return h.slice(2); // remove '#/'
  }

  function setHash(path) {
    location.hash = '#/' + path;
  }

  function isDir(name) {
    var node = getNode(name);
    return node !== null && typeof node === 'object';
  }

  function getNode(path) {
    if (!path) return TREE;
    var parts = path.split('/');
    var node = TREE;
    for (var i = 0; i < parts.length; i++) {
      if (typeof node !== 'object' || !(parts[i] in node)) return null;
      node = node[parts[i]];
    }
    return node;
  }

  function fetchFile(path) {
    if (cache[path]) return Promise.resolve(cache[path]);
    return fetch('/docs/' + path)
      .then(function (r) {
        if (!r.ok) throw new Error('Not found');
        return r.text();
      })
      .then(function (text) {
        cache[path] = text;
        return text;
      });
  }

  function buildBreadcrumb(path) {
    breadcrumbEl.innerHTML = '';
    var home = document.createElement('a');
    home.href = '#/';
    home.textContent = 'docs';
    home.className = 'docs-bc-link';
    breadcrumbEl.appendChild(home);

    if (!path) return;
    var parts = path.split('/');
    var accum = '';
    parts.forEach(function (part, idx) {
      var sep = document.createElement('span');
      sep.className = 'docs-bc-sep';
      sep.textContent = ' / ';
      breadcrumbEl.appendChild(sep);
      accum += (accum ? '/' : '') + part;
      if (idx < parts.length - 1) {
        var link = document.createElement('a');
        link.href = '#/' + accum;
        link.textContent = part;
        link.className = 'docs-bc-link';
        breadcrumbEl.appendChild(link);
      } else {
        var span = document.createElement('span');
        span.className = 'docs-bc-current';
        span.textContent = part;
        breadcrumbEl.appendChild(span);
      }
    });
  }

  function renderDir(path) {
    var node = getNode(path);
    if (!node || typeof node !== 'object') {
      contentEl.innerHTML = '<p>Not found.</p>';
      return;
    }

    var html = '';
    if (path) {
      html += '<h1>' + escapeHtml(path.split('/').pop()) + '</h1>';
    } else {
      html += '<h1>Documentation</h1>';
    }

    // Try to render README.md for this directory
    var readmePath = path ? path + '/README.md' : 'README.md';
    // keys/sort — до fetchFile, чтобы в .catch (каталог без README)
    // список строился по тем же ключам, а не падал ReferenceError
    var keys = Object.keys(node);
    keys.sort(function (a, b) {
      var aDir = typeof node[a] === 'object';
      var bDir = typeof node[b] === 'object';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    var self = this;
    fetchFile(readmePath).then(function (text) {
      // Render README as intro
      var readmeHtml = '<div class="docs-readme">' +
        renderMd(text, readmePath) + '</div>';
      // Build directory listing
      var listHtml = '<div class="docs-dir-list">';
      keys.forEach(function (name) {
        if (name === 'README.md') return; // already rendered
        var isD = typeof node[name] === 'object';
        var full = path ? path + '/' + name : name;
        var displayName = isD ? name + '/' : name;
        listHtml += '<a class="docs-dir-item' + (isD ? ' docs-dir-item--dir' : '') + '" href="#/' + full + '">';
        listHtml += isD ? '<span class="docs-tree-icon">\u25BC</span> ' : '';
        listHtml += escapeHtml(displayName);
        listHtml += '</a>';
      });
      listHtml += '</div>';
      contentEl.innerHTML = readmeHtml + listHtml;
      contentEl.scrollTop = 0;
    }).catch(function () {
      // No README — just list
      var listHtml = '';
      keys.forEach(function (name) {
        var isD = typeof node[name] === 'object';
        var full = path ? path + '/' + name : name;
        var displayName = isD ? name + '/' : name;
        listHtml += '<a class="docs-dir-item' + (isD ? ' docs-dir-item--dir' : '') + '" href="#/' + full + '">';
        listHtml += isD ? '<span class="docs-tree-icon">\u25BC</span> ' : '';
        listHtml += escapeHtml(displayName);
        listHtml += '</a>';
      });
      contentEl.innerHTML = '<h1>' + escapeHtml(path || 'Documentation') + '</h1><div class="docs-dir-list">' + listHtml + '</div>';
      contentEl.scrollTop = 0;
    });
  }

  function renderFile(path) {
    fetchFile(path).then(function (text) {
      contentEl.innerHTML = '<div class="docs-md">' + renderMd(text, path) + '</div>';
      contentEl.scrollTop = 0;
    }).catch(function () {
      contentEl.innerHTML = '<p>File not found: ' + escapeHtml(path) + '</p>';
    });
  }

  function updateTree() {
    treeEl.innerHTML = '';
    treeEl.appendChild(renderTree(TREE, '', expandedDirs));
  }

  function route() {
    var path = getHash();
    buildBreadcrumb(path);

    // Expand parent directories
    if (path) {
      var parts = path.split('/');
      var accum = '';
      for (var i = 0; i < parts.length - 1; i++) {
        accum += (accum ? '/' : '') + parts[i];
        expandedDirs[accum] = true;
      }
    }

    updateTree();

    if (!path) {
      renderDir('');
    } else if (isDir(path)) {
      expandedDirs[path] = !expandedDirs[path];
      updateTree();
      renderDir(path);
    } else {
      renderFile(path);
    }
  }

  /* ── Sidebar toggle (mobile) ── */
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      sidebarEl.classList.toggle('docs-sidebar--open');
    });
  }

  /* ── Tree click delegation ── */
  treeEl.addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    // Close sidebar on mobile after navigation
    if (window.innerWidth < 768) {
      sidebarEl.classList.remove('docs-sidebar--open');
    }
  });

  /* ── Init: сначала оглавление (tree.json), потом первый route() ── */
  window.addEventListener('hashchange', route);
  fetch('/docs/tree.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (json) {
      if (!json || typeof json !== 'object') throw new Error('tree.json: не объект');
      TREE = json;
      route();
    })
    .catch(function (err) {
      if (window.console && console.error) console.error('tree.json:', err);
      contentEl.innerHTML =
        '<p>Не удалось загрузить оглавление (tree.json). Обновите страницу; ' +
        'если не помогло — сообщите администратору.</p>';
    });
})();
