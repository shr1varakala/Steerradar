// js/photos.js — image compression, upload, preview
//
// v6.1: uploads use the signed-in session (see api.js) — no shared secret.
// Previews always come from the locally compressed image (never from a server
// URL), so a hostile URL can never be injected into the page. Sensitive slots
// (number plate, UPI QR) are stored privately on the server and never linked.

import { api } from './api.js';
import { session } from './store.js';

export async function compressImage(file, maxWidth = 1000, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function uploadImage(base64, folder, filename) {
  const res = await api.uploadImage(base64, folder, filename);
  if (!res) throw new Error(api.lastError || 'Upload failed');
  return res;
}

export async function deleteImage(fileId) {
  return api.deleteImage(fileId);
}

const SLOT_EMOJI = {
  avatar: '📷',
  vehiclePhoto: '🚗',
  platePhoto: '🔢',
  upiQr: '💳',
};

const toast = (msg, kind) => window.Steeradar?.showToast?.(msg, kind);

export function setupPhotoUploads({ folder = 'users', onUpload } = {}) {
  const uploaded = {};
  const cards = document.querySelectorAll('.photo-card');

  cards.forEach(card => {
    const input = card.querySelector('input[type="file"]');
    const preview = card.querySelector('.photo-preview');
    const slot = card.dataset.slot;
    if (!input || !preview) return;

    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      card.classList.remove('uploaded');
      card.classList.add('uploading');
      preview.textContent = 'Uploading…';

      try {
        const b64 = await compressImage(file, 1000, 0.7);

        // Local preview first (always safe: it's our own data: URL).
        const showPreview = (note) => {
          preview.textContent = '';
          const img = document.createElement('img');
          img.src = b64;
          img.alt = slot;
          preview.appendChild(img);
          const x = document.createElement('button');
          x.className = 'remove-photo';
          x.type = 'button';
          x.setAttribute('aria-label', 'Remove photo');
          x.textContent = '✕';
          x.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); removePhoto(slot, card, preview); };
          preview.appendChild(x);
          if (note) toast(note);
        };

        if (!session.isLoggedIn()) {
          // Not signed in → keep it on this device only.
          uploaded[slot] = { fileId: '', url: '', local: true };
          card.classList.remove('uploading');
          card.classList.add('uploaded');
          showPreview('Photo kept on this device. Sign in to back it up.');
        } else {
          const res = await uploadImage(b64, folder + '/' + slot, slot + '_' + Date.now() + '.jpg');
          uploaded[slot] = { fileId: res.fileId, url: res.url || '' };
          card.classList.remove('uploading');
          card.classList.add('uploaded');
          showPreview();
        }
        if (onUpload) onUpload(slot, uploaded[slot]);
      } catch (err) {
        card.classList.remove('uploading');
        preview.textContent = '⚠️';
        console.error('Upload failed:', err);
        toast('Upload failed: ' + err.message, 'error');
      }
    });
  });

  async function removePhoto(slot, card, preview) {
    const current = uploaded[slot];
    if (current && current.fileId) {
      try { await deleteImage(current.fileId); } catch (e) {}
    }
    delete uploaded[slot];
    card.classList.remove('uploaded');
    preview.textContent = SLOT_EMOJI[slot] || '📷';
    if (onUpload) onUpload(slot, null);
  }

  return {
    getAll: () => ({ ...uploaded }),
    has: (slot) => !!uploaded[slot],
    get: (slot) => uploaded[slot],
  };
}
