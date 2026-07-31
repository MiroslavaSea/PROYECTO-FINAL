import { auth } from '../firebase-config.js'
import { showToast } from './utils.js'
import { waitForAdminState, currentUser, currentUserData } from './admin-state.js'

const API_BASE  = 'https://refugioowoof.up.railway.app'
const MAX_SLOTS = 3

let selectedPhotos = [null, null, null]
let photoStates    = ['idle', 'idle', 'idle']  // 'idle'|'loading'|'valid'|'invalid'
let selectedSize   = ''
let selectedColor  = ''
let selectedSex    = ''
let _skipNextClick = [false, false, false]

let _nameInput, _phoneInput, _emailInput, _matchBtn

export function initReportFound() {
  // Tip modal compartido entre los 3 slots
  const photoTipOverlay  = document.getElementById('photo-tip-overlay')
  const photoTipCancel   = document.getElementById('photo-tip-cancel')
  const photoTipContinue = document.getElementById('photo-tip-continue')

  photoTipCancel.addEventListener('click', e => {
    e.stopPropagation()
    photoTipOverlay.classList.add('hidden')
  })

  photoTipContinue.addEventListener('click', e => {
    e.stopPropagation()
    const idx = parseInt(photoTipOverlay.dataset.slotIdx ?? '0')
    photoTipOverlay.classList.add('hidden')
    _skipNextClick[idx] = true
    setTimeout(() => document.getElementById(`photo-input-${idx + 1}`).click(), 50)
  })

  for (let i = 0; i < MAX_SLOTS; i++) {
    _initPhotoSlot(i, photoTipOverlay)
  }

  // Chips
  _bindChips('chips-size', val => {
    selectedSize = val
    document.getElementById('size-error').textContent = ''
    _updateSubmitBtn()
  })
  _bindChips('chips-sex', val => { selectedSex = val })
  _bindChips('chips-color', val => {
    selectedColor = val
    document.getElementById('color-other-wrapper').classList.toggle('hidden', val !== 'Otro')
    if (val !== 'Otro') document.getElementById('color-other').value = ''
    document.getElementById('color-error').textContent = ''
    _updateSubmitBtn()
  })
  document.getElementById('color-other').addEventListener('input', () => {
    const el = document.getElementById('color-other')
    const filtered = el.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]/g, '').slice(0, 20)
    if (el.value !== filtered) el.value = filtered
    const counter = document.getElementById('color-other-counter')
    if (counter) {
      counter.textContent = `${el.value.length}/20`
      counter.style.color = el.value.length >= 20 ? '#E53935' : 'rgba(255,255,255,0.35)'
    }
    _updateSubmitBtn()
  })

  document.getElementById('signs').addEventListener('input', () => {
    const el = document.getElementById('signs')
    const counter = document.getElementById('signs-counter')
    if (counter) {
      counter.textContent = `${el.value.length}/150`
      counter.style.color = el.value.length >= 150 ? '#E53935' : 'rgba(255,255,255,0.35)'
    }
  })

  // Campos de contacto
  _nameInput  = document.getElementById('reporter-name')
  _phoneInput = document.getElementById('reporter-phone')
  _emailInput = document.getElementById('reporter-email')
  _matchBtn   = document.getElementById('btn-match')

  waitForAdminState().then(() => {
    const user = currentUser
    const data = currentUserData
    if (data?.name  && !_nameInput.value)  _nameInput.value  = data.name.slice(0, 50)
    if (user?.email && !_emailInput.value) _emailInput.value = user.email
    if (data?.phone && !_phoneInput.value) _phoneInput.value = data.phone
    const counter = document.getElementById('reporter-name-counter')
    if (counter) counter.textContent = `${_nameInput.value.length}/50`
    _updateSubmitBtn()
  })

  _phoneInput.addEventListener('input', () => {
    _phoneInput.value = _phoneInput.value.replace(/[^\d+\s\-()]/g, '')
    document.getElementById('phone-wrapper').classList.remove('error')
    document.getElementById('phone-error').textContent = ''
    _updateSubmitBtn()
  })

  _nameInput.addEventListener('input', () => {
    const filtered = _nameInput.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]/g, '').slice(0, 50)
    if (_nameInput.value !== filtered) _nameInput.value = filtered
    const counter = document.getElementById('reporter-name-counter')
    if (counter) {
      counter.textContent = `${_nameInput.value.length}/50`
      counter.style.color = _nameInput.value.length >= 50 ? '#E53935' : 'rgba(255,255,255,0.35)'
    }
    document.getElementById('name-wrapper').classList.remove('error')
    document.getElementById('name-error').textContent = ''
    _updateSubmitBtn()
  })

  let emailTouched = false
  _emailInput.addEventListener('blur',  () => { emailTouched = true; _validateEmail(_emailInput); _updateSubmitBtn() })
  _emailInput.addEventListener('input', () => {
    if (emailTouched) _validateEmail(_emailInput)
    _updateSubmitBtn()
  })

  _matchBtn.disabled = true

  _matchBtn.addEventListener('click', async () => {
    const { valid, finalColor } = _validateForm()
    if (!valid) return

    _matchBtn.disabled = true
    _matchBtn.innerHTML = '<div class="spinner"></div> Analizando con IA...'

    try {
      const token = await auth.currentUser.getIdToken()
      const formData = new FormData()

      selectedPhotos.forEach((photo, i) => {
        if (photo && photoStates[i] === 'valid') {
          formData.append('photos', photo)
        }
      })

      formData.append('size',           selectedSize)
      formData.append('color',          finalColor)
      formData.append('sex',            selectedSex)
      formData.append('description',    document.getElementById('signs').value.trim())
      formData.append('reporter_name',  _nameInput.value.trim())
      formData.append('reporter_phone', _phoneInput.value.trim())
      formData.append('reporter_email', _emailInput.value.trim())

      const res = await fetch(`${API_BASE}/api/v1/match-found-dog`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Error ${res.status}`)
      }

      await res.json()
      _resetForm()
      showToast('Reporte registrado. Revisa las coincidencias en la lista.', false)
      document.querySelector('.nav-item[data-section="my-reports"]')?.click()
    } catch (err) {
      const msg = err.message.includes('fetch')
        ? '❌ No se pudo conectar con el servidor. Verifica que el backend esté corriendo.'
        : `❌ ${err.message}`
      showToast(msg)
    } finally {
      _matchBtn.disabled = false
      _matchBtn.innerHTML = 'Buscar coincidencias'
      _updateSubmitBtn()
    }
  })
}

function _updateSlotLocks() {
  const unlocked = selectedPhotos[0] !== null
  for (let i = 1; i < MAX_SLOTS; i++) {
    const overlay = document.getElementById(`photo-lock-overlay-${i + 1}`)
    if (overlay) overlay.classList.toggle('hidden', unlocked)
  }
}

function _initPhotoSlot(idx, photoTipOverlay) {
  const n          = idx + 1
  const uploadBox  = document.getElementById(`upload-box-${n}`)
  const photoInput = document.getElementById(`photo-input-${n}`)

  uploadBox.addEventListener('click', () => {
    if (idx > 0 && selectedPhotos[0] === null) {
      showToast('Primero agrega la Foto 1 (obligatoria)', false)
      return
    }
    if (_skipNextClick[idx]) { _skipNextClick[idx] = false; return }
    if (idx === 0) {
      photoTipOverlay.dataset.slotIdx = '0'
      photoTipOverlay.classList.remove('hidden')
      return
    }
    document.getElementById(`photo-input-${idx + 1}`).click()
  })

  photoInput.addEventListener('change', async e => {
    const file = e.target.files[0]
    if (!file) return

    selectedPhotos[idx] = file
    e.target.value = ''
    if (idx === 0) _updateSlotLocks()

    const preview     = document.getElementById(`upload-preview-${n}`)
    const placeholder = document.getElementById(`upload-placeholder-${n}`)
    const errText     = document.getElementById(`photo-error-${n}`)
    const refs        = _slotRefs(n)

    preview.src = URL.createObjectURL(file)
    preview.style.display = 'block'
    placeholder.style.display = 'none'
    errText.textContent = ''

    _setSlotState(idx, 'loading', refs)
    _updateSubmitBtn()

    try {
      const token = await auth.currentUser.getIdToken()
      const fd = new FormData()
      fd.append('photo', file)

      const res = await fetch(`${API_BASE}/api/v1/validate-found-photo`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: fd,
      })

      if (res.status === 409) {
        const err = await res.json().catch(() => ({}))
        _setSlotState(idx, 'invalid', refs, err.detail || 'Esta foto ya fue reportada anteriormente.')
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        _setSlotState(idx, 'invalid', refs, err.detail || 'Error al validar la foto.')
      } else {
        const data = await res.json()
        if (data.is_dog) {
          _setSlotState(idx, 'valid', refs)
        } else {
          _setSlotState(idx, 'invalid', refs, data.message || 'La foto no muestra un perro.')
        }
      }
    } catch {
      _setSlotState(idx, 'invalid', refs, 'No se pudo conectar con el servidor.')
    }

    _updateSubmitBtn()
  })
}

function _slotRefs(n) {
  return {
    loadingOverlay: document.getElementById(`photo-loading-overlay-${n}`),
    validBadge:     document.getElementById(`photo-valid-badge-${n}`),
    changeLabel:    document.getElementById(`photo-change-label-${n}`),
    errorOverlay:   document.getElementById(`photo-error-overlay-${n}`),
    statusRow:      document.getElementById(`photo-status-row-${n}`),
    uploadBox:      document.getElementById(`upload-box-${n}`),
  }
}

function _setSlotState(idx, state, { loadingOverlay, validBadge, changeLabel, errorOverlay, statusRow, uploadBox }, errorMsg = '') {
  photoStates[idx] = state

  loadingOverlay.classList.add('hidden')
  validBadge.classList.add('hidden')
  changeLabel.classList.add('hidden')
  errorOverlay.classList.add('hidden')
  uploadBox.classList.remove('has-photo', 'valid-photo', 'error-photo')
  statusRow.className = 'photo-status-row'
  statusRow.innerHTML = ''

  if (state === 'loading') {
    uploadBox.classList.add('has-photo')
    loadingOverlay.classList.remove('hidden')
    statusRow.classList.add('photo-status-row--loading')
    statusRow.innerHTML = `<span>Verificando con el servidor...</span>`

  } else if (state === 'valid') {
    uploadBox.classList.add('valid-photo')
    validBadge.classList.remove('hidden')
    changeLabel.classList.remove('hidden')
    statusRow.classList.add('photo-status-row--valid')
    statusRow.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>Foto válida</span>`

  } else if (state === 'invalid') {
    uploadBox.classList.add('error-photo')
    errorOverlay.classList.remove('hidden')
    statusRow.classList.add('photo-status-row--invalid')
    statusRow.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      <span>${errorMsg}</span>`

  } else {
    // idle
    statusRow.classList.add('photo-status-row--hint')
    const label = idx === 0 ? 'Foto principal' : 'Foto adicional'
    statusRow.innerHTML = `<span>${label}</span>`
  }
}

function _resetForm() {
  selectedPhotos   = [null, null, null]
  photoStates      = ['idle', 'idle', 'idle']
  selectedSize     = ''
  selectedColor    = ''
  selectedSex      = ''
  _skipNextClick   = [false, false, false]

  for (let i = 0; i < MAX_SLOTS; i++) {
    const n = i + 1
    const preview     = document.getElementById(`upload-preview-${n}`)
    const placeholder = document.getElementById(`upload-placeholder-${n}`)

    preview.style.display = 'none'
    preview.src = ''
    placeholder.style.display = ''

    const refs = _slotRefs(n)
    _setSlotState(i, 'idle', refs)
  }

  _updateSlotLocks()
  document.getElementById('photo-error').textContent = ''

  ;['chips-size', 'chips-color', 'chips-sex'].forEach(groupId => {
    document.getElementById(groupId).querySelectorAll('.chip').forEach(c => c.classList.remove('selected'))
  })
  document.getElementById('color-other-wrapper').classList.add('hidden')
  document.getElementById('color-other').value = ''
  document.getElementById('signs').value = ''

  ;['size-error', 'color-error', 'name-error', 'phone-error', 'email-r-error'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.textContent = ''
  })
  ;['name-wrapper', 'phone-wrapper', 'email-r-wrapper'].forEach(id => {
    document.getElementById(id)?.classList.remove('error')
  })

  if (_nameInput)  _nameInput.value  = (currentUserData?.name  || '').slice(0, 50)
  if (_emailInput) _emailInput.value = currentUser?.email      || ''
  if (_phoneInput) _phoneInput.value = currentUserData?.phone  || ''

  const nameC  = document.getElementById('reporter-name-counter')
  const colorC = document.getElementById('color-other-counter')
  const signsC = document.getElementById('signs-counter')
  if (nameC)  { nameC.textContent  = `${_nameInput?.value.length ?? 0}/50`;  nameC.style.color  = 'rgba(255,255,255,0.35)' }
  if (colorC) { colorC.textContent = '0/20'; colorC.style.color = 'rgba(255,255,255,0.35)' }
  if (signsC) { signsC.textContent = '0/150'; signsC.style.color = 'rgba(255,255,255,0.35)' }

  _updateSubmitBtn()
}

function _updateSubmitBtn() {
  if (!_matchBtn) return
  const finalColor = selectedColor === 'Otro'
    ? (document.getElementById('color-other')?.value.trim() ?? '')
    : selectedColor

  const atLeastOneValid = photoStates[0] === 'valid'
  const ready = atLeastOneValid &&
    selectedSize !== '' &&
    finalColor   !== '' &&
    (_nameInput?.value.trim()  ?? '') !== '' &&
    (_phoneInput?.value.trim() ?? '') !== '' &&
    (_emailInput?.value.trim() ?? '') !== '' &&
    _isValidEmail(_emailInput?.value.trim() ?? '')

  _matchBtn.disabled = !ready
}

function _validateForm() {
  let valid = true

  if (photoStates[0] !== 'valid') {
    document.getElementById('photo-error').textContent = 'La foto principal (Foto 1) debe ser válida antes de continuar'
    valid = false
  } else {
    document.getElementById('photo-error').textContent = ''
  }

  if (!selectedSize) {
    document.getElementById('size-error').textContent = 'Selecciona el tamaño'
    valid = false
  }

  const finalColor = selectedColor === 'Otro'
    ? document.getElementById('color-other').value.trim()
    : selectedColor
  if (!finalColor) {
    document.getElementById('color-error').textContent = 'Selecciona o describe el color'
    valid = false
  }

  if (!_nameInput.value.trim()) {
    document.getElementById('name-wrapper').classList.add('error')
    document.getElementById('name-error').textContent = 'El nombre es requerido'
    valid = false
  }
  if (!_phoneInput.value.trim()) {
    document.getElementById('phone-wrapper').classList.add('error')
    document.getElementById('phone-error').textContent = 'El teléfono es requerido'
    valid = false
  }
  const emailVal = _emailInput.value.trim()
  if (!emailVal) {
    document.getElementById('email-r-wrapper').classList.add('error')
    document.getElementById('email-r-error').textContent = 'El correo es requerido'
    valid = false
  } else if (!_isValidEmail(emailVal)) {
    document.getElementById('email-r-wrapper').classList.add('error')
    document.getElementById('email-r-error').textContent = 'Formato de correo no válido'
    valid = false
  }

  return { valid, finalColor }
}

function _bindChips(groupId, onChange) {
  document.getElementById(groupId).querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById(groupId).querySelectorAll('.chip').forEach(c => c.classList.remove('selected'))
      chip.classList.add('selected')
      onChange(chip.dataset.value)
    })
  })
}

function _isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function _validateEmail(input) {
  const val     = input.value.trim()
  const wrapper = document.getElementById('email-r-wrapper')
  const err     = document.getElementById('email-r-error')
  if (val && !_isValidEmail(val)) {
    wrapper.classList.add('error')
    err.textContent = 'Formato de correo no válido'
  } else {
    wrapper.classList.remove('error')
    err.textContent = ''
  }
}

