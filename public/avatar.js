'use strict';

// A round avatar: the GitHub profile picture when the account is tied to GitHub (user.avatarUrl), otherwise the initials.
// The initials stay underneath, so they show while the picture loads and if it can't be loaded.
(function () {
  function set(el, user, initials) {
    el.replaceChildren();
    el.textContent = initials;
    if (!user || !user.avatarUrl) return;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer'; // GitHub learns nothing about which page asked
    img.addEventListener('error', () => img.remove());
    img.src = user.avatarUrl;
    el.append(img);
  }
  window.CCAvatar = { set };
})();
