// Highlighting for snippet commands, in the Snippets list and the terminal's
// Snippets picker. One tokenizer for the shells a snippet may be sent to: sh
// and bash (Linux, macOS), cmd and PowerShell (Windows). A word where a
// command goes is a command, whatever it is; the lists below only name the
// builtins and keywords, and the commands to look for after sudo and the like.
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShellHighlight = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

  // Keywords that start a command after them, and those that end one.
  const KEYWORDS = words(`if then else elif fi for while until do done case esac in function select
    foreach switch try catch finally param return break continue exit
    not exist errorlevel defined goto setlocal endlocal`);
  const STARTS_COMMAND = words('if then else elif while until do ! { foreach try finally not');
  // Built into the shell: sh/bash/zsh, cmd.
  const BUILTINS = words(`alias bg cd bind builtin caller command compgen complete declare dirs disown echo
    enable eval exec export false fc fg getopts hash help history jobs kill let local logout mapfile
    popd printf pushd pwd read readonly set shift shopt source suspend test times trap true type
    typeset ulimit umask unalias unset wait
    call cls chdir color copy del dir erase md mkdir move pause rd ren rename rmdir start title ver vol`);
  // Run another command: the first word after them (and their own flags)
  // that looks like one is a command too.
  const PREFIXES = words('sudo doas time nohup nice ionice env exec xargs watch command builtin timeout strace caffeinate runas stdbuf chroot flock');
  // Common commands on Linux, macOS and Windows.
  const COMMANDS = words(`
    awk base64 basename bash bzip2 cat chgrp chmod chown cksum clear cmp comm cp crontab csplit curl cut
    date dd df diff dig dirname dmesg du emacs expand expr fdisk file find fmt fold free fsck ftp
    gawk git gpg grep groups gunzip gzip head host hostname htop id ifconfig install ip iptables
    journalctl join jq kill killall last less link ln locale logger login ls lsblk lsof make man md5sum
    mkfifo mknod mktemp more mount mv nano nc netstat nl node nohup npm npx nslookup od passwd paste
    patch perl pgrep ping pip pip3 pkill printenv ps python python3 readlink realpath reboot rm rsync
    scp screen sed seq service sftp sh sha1sum sha256sum shutdown sleep sort split ss ssh ssh-keygen
    stat su sync sysctl systemctl tac tail tar tee telnet tmux top touch tr traceroute tree truncate
    tty uname uniq unlink unzip uptime useradd userdel usermod vi vim wc wget whereis which who whoami
    yes zip zsh apt apt-get dnf yum pacman apk snap flatpak docker podman kubectl helm systemd-analyze
    ufw firewall-cmd nmcli lsmod modprobe crontab cron at chattr lsattr nproc lscpu vmstat iostat
    open pbcopy pbpaste brew defaults launchctl diskutil softwareupdate networksetup scutil say
    sw_vers system_profiler pmset mdfind mdls osascript plutil ditto hdiutil tmutil
    cmd powershell pwsh ipconfig ping tracert pathping netsh tasklist taskkill robocopy xcopy
    attrib chkdsk diskpart sfc dism systeminfo whoami wmic schtasks sc reg shutdown findstr
    where type fc more tree cipher icacls takeown net winget choco scoop wsl certutil`);
  // PowerShell cmdlets: Verb-Noun.
  const CMDLET = /^[A-Z][a-z]+-[A-Z][A-Za-z]+$/;
  const PLACEHOLDER = /^\$\{[A-Za-z_][\w.-]{0,39}\}/;
  const VARIABLE = /^(?:\$\{[^}\s]*\}|\$env:\w+|\$[A-Za-z_]\w*|\$[0-9?@#$!*-]|%%?[A-Za-z]\b|%[A-Za-z_][\w()-]*%)/;
  const NUMBER = /^-?\d+(?:\.\d+)?[kKmMgGtT%]?$/;
  const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

  // The text as [type, text] pairs, which join back into the text. Types:
  // command, builtin, keyword, flag, string, variable, placeholder,
  // operator, comment, number and plain.
  function tokenize(text) {
    const out = [];
    const push = (type, s) => {
      if (!s) return;
      const last = out[out.length - 1];
      if (last && last[0] === type) last[1] += s;
      else out.push([type, s]);
    };
    let i = 0;
    let start = true; // where a command goes
    let afterPrefix = false; // after sudo and the like: skip their flags
    let lastFlag = false; // the word before was a flag (it may take a value)

    // Variables and placeholders inside double quotes (and the placeholders
    // snippets fill in, even in single quotes).
    function quoted(q) {
      let j = i + 1;
      let run = q;
      const flush = () => { push('string', run); run = ''; };
      while (j < text.length && text[j] !== q) {
        const rest = text.slice(j);
        const ph = rest.match(PLACEHOLDER);
        const v = q === '"' && !ph && rest.match(VARIABLE);
        if (ph || v) {
          flush();
          push(ph ? 'placeholder' : 'variable', (ph || v)[0]);
          j += (ph || v)[0].length;
          continue;
        }
        if (text[j] === '\\' && q !== "'" && j + 1 < text.length) { run += text.slice(j, j + 2); j += 2; continue; }
        run += text[j++];
      }
      if (j < text.length) run += text[j++];
      flush();
      i = j;
    }

    function word(w) {
      if (start) {
        const assign = w.match(ASSIGNMENT);
        if (assign) {
          const name = assign[0].replace(/\+?=$/, '');
          push('variable', name);
          push('operator', assign[0].slice(name.length));
          push('plain', w.slice(assign[0].length));
          return;
        }
        const bare = w.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
        const lower = bare.toLowerCase();
        if (afterPrefix && /^(?:-|\/[A-Za-z?]{1,4}(?::|$))/.test(w)) { push('flag', w); lastFlag = true; return; }
        if (afterPrefix && NUMBER.test(w)) { push('number', w); lastFlag = false; return; }
        if (afterPrefix && lastFlag && !COMMANDS.has(lower) && !BUILTINS.has(lower) && !PREFIXES.has(lower)) {
          push('plain', w);
          lastFlag = false;
          return;
        }
        lastFlag = false;
        if (KEYWORDS.has(lower) && !afterPrefix) {
          push('keyword', w);
          start = STARTS_COMMAND.has(lower);
          return;
        }
        if (PREFIXES.has(lower)) { push('command', w); afterPrefix = true; return; }
        push(BUILTINS.has(lower) ? 'builtin' : 'command', w);
        start = afterPrefix = false;
        return;
      }
      if (CMDLET.test(w)) push('command', w);
      else if (/^--?[A-Za-z0-9?]/.test(w) || /^\/[A-Za-z?]{1,2}(?::\S*)?$/.test(w)) push('flag', w);
      else if (NUMBER.test(w)) push('number', w);
      else push('plain', w);
    }

    while (i < text.length) {
      const c = text[i];
      const rest = text.slice(i);
      let m;
      if (c === '\n') { push('plain', c); i++; start = true; afterPrefix = lastFlag = false; continue; }
      if (/\s/.test(c)) { m = rest.match(/^[^\S\n]+/); push('plain', m[0]); i += m[0].length; continue; }
      const prev = i ? text[i - 1] : '\n';
      if ((c === '#' && /\s/.test(prev)) || (start && /^(?:rem\b|::)/i.test(rest))) {
        m = rest.match(/^[^\n]*/);
        push('comment', m[0]);
        i += m[0].length;
        continue;
      }
      // A backtick with no partner on its line is PowerShell's line continuation.
      if (c === '"' || c === "'" || (c === '`' && /^`[^`\n]*`/.test(rest))) {
        quoted(c);
        if (start) start = afterPrefix = false;
        continue;
      }
      if ((m = rest.match(PLACEHOLDER))) {
        push('placeholder', m[0]);
        i += m[0].length;
        if (start) start = afterPrefix = false;
        continue;
      }
      if ((m = rest.match(/^(?:&&|\|\||;;|\|&?|;|&(?!>)|\$\(|\(|\)|\{(?=\s)|\}(?=\s|;|$))/))) {
        push('operator', m[0]);
        i += m[0].length;
        start = m[0] !== ')' && m[0] !== '}';
        afterPrefix = lastFlag = false;
        continue;
      }
      if ((m = rest.match(/^(?:\d?>>?(?:&\d|&-)?|&>>?|<<<?|<(?:&\d)?|\d?>\|)/))) {
        push('operator', m[0]);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(VARIABLE))) {
        push('variable', m[0]);
        i += m[0].length;
        if (start) start = afterPrefix = false;
        continue;
      }
      // A word: up to a space, quote, operator or variable; a backslash
      // escapes the next character (or is a Windows path separator).
      m = rest.match(/^(?:\\[\s\S]|[^\s"'`|&;()<>$\\]|\$(?![\w{?@#!*-]))+/);
      if (!m) { push('plain', c); i++; continue; }
      i += m[0].length;
      word(m[0]);
    }
    return out;
  }

  return { tokenize };
});
