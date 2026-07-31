import { db, auth } from '../firebase-config.js'
import {
  collection, getDocs, query, where,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
import {
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'

// ── Esperar a que Firebase Auth esté listo ─────────────────────────────────────
function _waitForUser() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser)
  return new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, user => { unsub(); resolve(user) })
  })
}

// ── Chart instances ───────────────────────────────────────────────────────────
let _charts = {}
let _refreshBound        = false
let _activityFilterBound = false
let _pdfBound            = false

// ── Datos cacheados para re-render sin re-fetch ───────────────────────────────
let _lostDogsData     = []
let _foundReportsData = []
let _activityFilter   = 'monthly'
let _activityFrom     = null
let _activityTo       = null
let _kpiData          = {}

function _destroyCharts() {
  Object.values(_charts).forEach(c => { try { c?.destroy() } catch (_) {} })
  _charts = {}
}

// ── Animaciones ───────────────────────────────────────────────────────────────
function _animateCount(id, target) {
  const el = document.getElementById(id)
  if (!el) return
  const start = performance.now()
  const step = (now) => {
    const p = Math.min((now - start) / 700, 1)
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)))
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ── Colores y estilos Chart.js ────────────────────────────────────────────────
const C = {
  gold:   '#D4AF37', goldA:   'rgba(212,175,55,0.75)',
  green:  '#4CAF50', greenA:  'rgba(76,175,80,0.75)',
  blue:   '#4FC3F7', blueA:   'rgba(79,195,247,0.75)',
  red:    '#EF5350', redA:    'rgba(239,83,80,0.72)',
}
const _grid    = { color: 'rgba(255,255,255,0.06)' }
const _tick    = { color: 'rgba(255,255,255,0.55)', font: { size: 11 } }
const _tooltip = {
  backgroundColor: '#1C1C1C', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
  titleColor: '#fff', bodyColor: 'rgba(255,255,255,0.7)', padding: 10,
}
const _legendBottom = {
  position: 'bottom',
  labels: { color: 'rgba(255,255,255,0.65)', font: { size: 12 }, boxWidth: 14, padding: 16 },
}
const _legendTop = {
  labels: { color: 'rgba(255,255,255,0.65)', font: { size: 12 }, boxWidth: 14 },
}

// ── Leyenda con porcentaje al costado (para donas) ─────────────────────────────
function _legendPercent() {
  return {
    position: 'right',
    labels: {
      color: '#FFFFFF',
      font: { size: 12, weight: 'bold' },
      boxWidth: 14,
      padding: 14,
      generateLabels(chart) {
        const { labels, datasets } = chart.data
        if (!labels?.length || !datasets?.length) return []
        const ds    = datasets[0]
        const total = ds.data.reduce((a, b) => a + b, 0)
        return labels.map((label, i) => {
          const value = ds.data[i]
          const pct   = total > 0 ? Math.round((value / total) * 100) : 0
          return {
            text: `${label}: ${pct}%`,
            fillStyle: ds.backgroundColor[i],
            strokeStyle: ds.borderColor[i],
            lineWidth: ds.borderWidth,
            hidden: false,
            index: i,
          }
        })
      },
    },
  }
}

// ── Datos del gráfico según filtro activo ─────────────────────────────────────
function _getChartDataForFilter(filter, from, to) {
  const now = new Date()

  if (filter === 'daily') {
    // Solo hoy, desglosado por hora (0h–23h)
    const year  = now.getFullYear()
    const month = now.getMonth()
    const day   = now.getDate()
    const hours = Array.from({ length: 24 }, (_, h) => h)
    const matchHour = (items, h) => items.filter(x => {
      const ts = x.created_at?.toDate?.()
      return ts && ts.getFullYear() === year && ts.getMonth() === month &&
             ts.getDate() === day && ts.getHours() === h
    }).length
    return {
      labels:    hours.map(h => `${h}h`),
      lostData:  hours.map(h => matchHour(_lostDogsData, h)),
      foundData: hours.map(h => matchHour(_foundReportsData, h)),
    }
  }

  if (filter === 'weekly') {
    // Lunes a domingo de la semana actual
    const today      = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dow        = today.getDay()
    const fromMonday = dow === 0 ? 6 : dow - 1
    const monday     = new Date(today)
    monday.setDate(today.getDate() - fromMonday)
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      return {
        label: d.toLocaleString('es', { weekday: 'short', day: 'numeric' }),
        year: d.getFullYear(), month: d.getMonth(), day: d.getDate(),
      }
    })
    const matchDay = (items, d) => items.filter(x => {
      const ts = x.created_at?.toDate?.()
      return ts && ts.getFullYear() === d.year && ts.getMonth() === d.month && ts.getDate() === d.day
    }).length
    return {
      labels:    days.map(d => d.label),
      lostData:  days.map(d => matchDay(_lostDogsData, d)),
      foundData: days.map(d => matchDay(_foundReportsData, d)),
    }
  }

  if (filter === 'monthly') {
    // Día a día del mes actual
    const year        = now.getFullYear()
    const month       = now.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const days = Array.from({ length: daysInMonth }, (_, i) => ({ label: String(i + 1), year, month, day: i + 1 }))
    const matchDay = (items, d) => items.filter(x => {
      const ts = x.created_at?.toDate?.()
      return ts && ts.getFullYear() === d.year && ts.getMonth() === d.month && ts.getDate() === d.day
    }).length
    return {
      labels:    days.map(d => d.label),
      lostData:  days.map(d => matchDay(_lostDogsData, d)),
      foundData: days.map(d => matchDay(_foundReportsData, d)),
    }
  }

  if (filter === 'range' && from && to) {
    const fromDate = new Date(from + 'T00:00:00')
    const toDate   = new Date(to   + 'T23:59:59')
    const days = []
    const curr = new Date(fromDate)
    while (curr <= toDate && days.length < 60) {
      days.push(new Date(curr.getFullYear(), curr.getMonth(), curr.getDate()))
      curr.setDate(curr.getDate() + 1)
    }
    const matchDay = (items, d) => items.filter(x => {
      const ts = x.created_at?.toDate?.()
      return ts && ts.getFullYear() === d.getFullYear() &&
             ts.getMonth() === d.getMonth() && ts.getDate() === d.getDate()
    }).length
    return {
      labels:    days.map(d => d.toLocaleString('es', { day: '2-digit', month: 'short' })),
      lostData:  days.map(d => matchDay(_lostDogsData, d)),
      foundData: days.map(d => matchDay(_foundReportsData, d)),
    }
  }

  return null
}

// ── Gráfica de actividad (se re-renderiza al cambiar filtro) ──────────────────
function _refreshActivityChart() {
  const rangeEl = document.getElementById('activity-date-range-inputs')
  if (rangeEl) rangeEl.classList.toggle('hidden', _activityFilter !== 'range')

  if (_activityFilter === 'range' && (!_activityFrom || !_activityTo)) return

  const data = _getChartDataForFilter(_activityFilter, _activityFrom, _activityTo)
  if (!data) return

  if (_charts.activity) { try { _charts.activity.destroy() } catch (_) {} }

  try {
    const ctx = document.getElementById('chart-monthly')
    if (!ctx) return
    _charts.activity = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Perdidos',
            data: data.lostData,
            backgroundColor: C.goldA, borderColor: C.gold,
            borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
          },
          {
            label: 'Encontrados',
            data: data.foundData,
            backgroundColor: C.greenA, borderColor: C.green,
            borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 700, easing: 'easeOutQuart' },
        plugins: { legend: _legendTop, tooltip: _tooltip },
        scales: {
          x: { grid: _grid, ticks: _tick },
          y: { grid: _grid, ticks: { ..._tick, stepSize: 1 }, beginAtZero: true },
        },
      },
    })
  } catch (e) { console.warn('chart-activity:', e) }
}

// ── Dona: estado de perros perdidos ───────────────────────────────────────────
function _renderStatusLost(active, inactive) {
  try {
    const ctx = document.getElementById('chart-status-lost')
    if (!ctx || active + inactive === 0) return
    _charts.statusLost = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Activos', 'Inactivos'],
        datasets: [{ data: [active, inactive], backgroundColor: [C.goldA, C.greenA], borderColor: [C.gold, C.green], borderWidth: 2, hoverOffset: 8 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        animation: { animateRotate: true, duration: 900, easing: 'easeOutQuart' },
        plugins: { legend: _legendPercent(), tooltip: _tooltip },
      },
    })
  } catch (e) { console.warn('chart-status-lost:', e) }
}

// ── Dona: estado de perros encontrados ────────────────────────────────────────
function _renderStatusFound(active, inactive) {
  try {
    const ctx = document.getElementById('chart-status-found')
    if (!ctx || active + inactive === 0) return
    _charts.statusFound = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Activos', 'Inactivos'],
        datasets: [{ data: [active, inactive], backgroundColor: [C.greenA, C.redA], borderColor: [C.green, C.red], borderWidth: 2, hoverOffset: 8 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        animation: { animateRotate: true, duration: 900, easing: 'easeOutQuart' },
        plugins: { legend: _legendPercent(), tooltip: _tooltip },
      },
    })
  } catch (e) { console.warn('chart-status-found:', e) }
}

// ── Dona: usuarios activos vs bloqueados ──────────────────────────────────────
function _renderUsersStatus(active, blocked) {
  try {
    const ctx = document.getElementById('chart-users-status')
    if (!ctx || active + blocked === 0) return
    _charts.usersStatus = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Activos', 'Bloqueados'],
        datasets: [{ data: [active, blocked], backgroundColor: [C.blueA, C.redA], borderColor: [C.blue, C.red], borderWidth: 2, hoverOffset: 8 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        animation: { animateRotate: true, duration: 900, easing: 'easeOutQuart' },
        plugins: { legend: _legendPercent(), tooltip: _tooltip },
      },
    })
  } catch (e) { console.warn('chart-users-status:', e) }
}

// ── Gráfico: distribución de permanencia ─────────────────────────────────────
function _renderPermanencia(foundReports, adminUid) {
  try {
    const ctx = document.getElementById('chart-permanencia')
    if (!ctx) return

    const now = new Date()
    const buckets = [
      { label: '1-7 días',   min: 0,  max: 7 },
      { label: '8-15 días',  min: 8,  max: 15 },
      { label: '16-30 días', min: 16, max: 30 },
      { label: '31-60 días', min: 31, max: 60 },
      { label: '+60 días',   min: 61, max: Infinity },
    ]
    const activeCount   = new Array(buckets.length).fill(0)
    const resolvedCount = new Array(buckets.length).fill(0)

    foundReports
      .filter(r => r.found_by_uid === adminUid)
      .forEach(r => {
        const start = r.created_at?.toDate?.()
        if (!start) return
        const isActive   = !r.status || r.status === 'active'
        const isResolved = r.returned_to_owner === true ||
          r.deactivation_reason === 'Fue devuelto al dueño' ||
          r.deactivation_reason === 'El perro ya fue entregado a su dueño'
        if (!isActive && !isResolved) return
        const end  = r.deactivated_at?.toDate?.() ?? now
        const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)))
        const bi   = buckets.findIndex(b => days >= b.min && days <= b.max)
        if (bi === -1) return
        if (isActive) activeCount[bi]++
        else resolvedCount[bi]++
      })

    _charts.permanencia = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [
          {
            label: 'Aún buscando (activo)',
            data: activeCount,
            backgroundColor: C.goldA, borderColor: C.gold,
            borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
          },
          {
            label: 'Devuelto al dueño',
            data: resolvedCount,
            backgroundColor: C.greenA, borderColor: C.green,
            borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 700, easing: 'easeOutQuart' },
        plugins: {
          legend: _legendTop,
          tooltip: {
            ..._tooltip,
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} perro${ctx.parsed.y !== 1 ? 's' : ''}`,
            },
          },
        },
        scales: {
          x: { grid: _grid, ticks: _tick, stacked: false },
          y: {
            grid: _grid,
            ticks: { ..._tick, stepSize: 1 },
            beginAtZero: true,
            title: { display: true, text: 'Cantidad de reportes', color: 'rgba(255,255,255,0.45)', font: { size: 11 } },
          },
        },
      },
    })
  } catch (e) { console.warn('chart-permanencia:', e) }
}

// ── Carga principal ───────────────────────────────────────────────────────────
export async function loadDashboard() {
  if (!_refreshBound) {
    _refreshBound = true
    document.getElementById('btn-refresh-dashboard')
      ?.addEventListener('click', loadDashboard)
  }

  if (!_pdfBound) {
    _pdfBound = true
    document.getElementById('btn-pdf-dashboard')
      ?.addEventListener('click', _generateDashboardPDF)
  }

  if (!_activityFilterBound) {
    _activityFilterBound = true

    document.querySelectorAll('.activity-filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.activity-filter-tab').forEach(t => t.classList.remove('active'))
        tab.classList.add('active')
        _activityFilter = tab.dataset.activityFilter
        _refreshActivityChart()
      })
    })

    const fromInput = document.getElementById('activity-date-from')
    const toInput   = document.getElementById('activity-date-to')
    fromInput?.addEventListener('change', () => {
      if (toInput) {
        toInput.min = fromInput.value
        if (toInput.value && toInput.value < fromInput.value) toInput.value = ''
      }
    })
    document.getElementById('activity-btn-apply-range')?.addEventListener('click', () => {
      _activityFrom = fromInput?.value || null
      _activityTo   = toInput?.value   || null
      _refreshActivityChart()
    })
  }

  // Reset visual KPIs
  ;['kpi-users','kpi-blocked','kpi-lost-active','kpi-found','kpi-matches','kpi-resolved']
    .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—' })
  const matchRateEl = document.getElementById('kpi-match-rate')
  if (matchRateEl) matchRateEl.textContent = '—'

  const user = await _waitForUser()
  if (!user) return
  try { await user.getIdToken(true) } catch (_) {}

  let users = [], lostDogs = [], foundReports = []

  try {
    const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'USER')))
    users = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) { console.warn('Leer users:', e.message) }

  try {
    const [lostSnap, foundSnap] = await Promise.all([
      getDocs(collection(db, 'lost_dogs')),
      getDocs(collection(db, 'found_dog_reports')),
    ])
    lostDogs     = lostSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    foundReports = foundSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) { console.error('Leer dogs/found:', e.message) }

  _lostDogsData     = lostDogs
  _foundReportsData = foundReports

  // ── KPIs ──────────────────────────────────────────────────────────────────────
  const totalUsers   = users.length
  const blockedUsers = users.filter(u => u.isBlocked).length
  const activeUsers  = totalUsers - blockedUsers

  const activeLost   = lostDogs.filter(d => d.status === 'active').length
  const inactiveLost = lostDogs.filter(d => d.status && d.status !== 'active').length

  const activeFound   = foundReports.filter(r => r.status === 'active').length
  const inactiveFound = foundReports.filter(r => r.status && r.status !== 'active').length

  const resolvedLost  = lostDogs.filter(d =>
    d.status !== 'active' &&
    (d.deactivation_reason === 'El perro ya fue recuperado' ||
     d.deactivation_reason === 'Ya encontré a mi perro')
  ).length
  const resolvedFound = foundReports.filter(r =>
    r.status !== 'active' &&
    (r.deactivation_reason === 'El perro ya fue entregado a su dueño' ||
     r.deactivation_reason === 'Fue devuelto al dueño')
  ).length
  const totalResolved = resolvedLost + resolvedFound

  const totalFound   = foundReports.length
  const totalMatches = foundReports.reduce((acc, r) => acc + (r.matches?.filter(m => (m.similarity_percent ?? 0) >= 50).length ?? 0), 0)

  const withMatches = foundReports.filter(r => (r.matches?.filter(m => (m.similarity_percent ?? 0) >= 50).length ?? 0) > 0).length
  const matchRate   = totalFound > 0 ? Math.round((withMatches / totalFound) * 100) : 0

  // Permanencia promedio: reportes de encontrados del refugio (admin) que ya fueron cerrados
  const dogsWithPermanencia = foundReports.filter(d =>
    d.found_by_uid === user.uid &&
    d.deactivated_at?.toDate?.() &&
    d.created_at?.toDate?.()
  )
  const avgPermanencia = dogsWithPermanencia.length > 0
    ? Math.round(
        dogsWithPermanencia.reduce((sum, d) => {
          return sum + (d.deactivated_at.toDate() - d.created_at.toDate()) / (1000 * 60 * 60 * 24)
        }, 0) / dogsWithPermanencia.length
      )
    : 0

  _kpiData = { totalUsers, blockedUsers, activeLost, inactiveLost, activeFound, inactiveFound, totalFound, totalMatches, matchRate, totalResolved, avgPermanencia, permanenciaCount: dogsWithPermanencia.length }

  _animateCount('kpi-users',            totalUsers)
  _animateCount('kpi-blocked',          blockedUsers)
  _animateCount('kpi-lost-active',      activeLost)
  _animateCount('kpi-found',            totalFound)
  _animateCount('kpi-matches',          totalMatches)
  _animateCount('kpi-resolved',         totalResolved)

  // ── Gráficos ──────────────────────────────────────────────────────────────────
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js no cargó. Verifica la conexión a internet.')
    return
  }

  _destroyCharts()
  _refreshActivityChart()
  _renderStatusLost(activeLost, inactiveLost)
  _renderStatusFound(activeFound, inactiveFound)
  _renderUsersStatus(activeUsers, blockedUsers)
  _renderPermanencia(foundReports, user.uid)
}

// ── Generador de PDF del Dashboard ───────────────────────────────────────────
function _generateDashboardPDF() {
  if (!window.jspdf) { alert('La librería PDF no está disponible. Verifica tu conexión.'); return }
  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const DARK  = [26, 26, 26]
  const GOLD  = [212, 175, 55]
  const GRAY  = [110, 110, 110]
  const LGRAY = [245, 245, 245]

  const now     = new Date()
  const dateStr = now.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' })
  const timeStr = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })

  // ── Cabecera ──────────────────────────────────────────────────────────────
  doc.setFillColor(...DARK)
  doc.rect(0, 0, 210, 26, 'F')
  doc.setFillColor(...GOLD)
  doc.rect(0, 26, 210, 1.5, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(17)
  doc.setTextColor(...GOLD)
  doc.text('Refugio WOOF', 14, 12)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(180, 180, 180)
  doc.text('Panel Administrativo - Reporte General del Dashboard', 14, 20)

  doc.setFontSize(8)
  doc.setTextColor(160, 160, 160)
  doc.text(`Generado: ${dateStr}, ${timeStr}`, 196, 12, { align: 'right' })

  // ── KPIs ──────────────────────────────────────────────────────────────────
  let y = 38
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(...DARK)
  doc.text('Resumen General', 14, y)
  y += 5

  doc.autoTable({
    startY: y,
    head: [['Indicador', 'Valor']],
    body: [
      ['Usuarios registrados',        String(_kpiData.totalUsers    ?? 'N/A')],
      ['Usuarios bloqueados',         String(_kpiData.blockedUsers  ?? 'N/A')],
      ['Perros extraviados activos',  String(_kpiData.activeLost    ?? 'N/A')],
      ['Reportes de encontrados',     String(_kpiData.totalFound    ?? 'N/A')],
      ['Coincidencias IA >=50%',      String(_kpiData.totalMatches  ?? 'N/A')],
      ['Casos resueltos',             String(_kpiData.totalResolved ?? 'N/A')],
    ],
    styles:            { fontSize: 10, cellPadding: 4 },
    headStyles:        { fillColor: DARK, textColor: GOLD, fontStyle: 'bold' },
    alternateRowStyles:{ fillColor: LGRAY },
    columnStyles:      { 0: { fontStyle: 'bold', cellWidth: 120 }, 1: { halign: 'center' } },
    margin:            { left: 14, right: 14 },
    theme: 'grid',
  })

  y = doc.lastAutoTable.finalY + 12

  // ── Grafico de actividad (barra) — pagina propia ──────────────────────────
  doc.addPage()
  let yC = 20

  const activityCanvas = document.getElementById('chart-monthly')
  if (activityCanvas) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(...DARK)
    doc.text('Actividad de Reportes', 14, yC)
    yC += 7

    const _filterLabels = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual', range: 'Rango de fechas' }
    let _periodLabel = _filterLabels[_activityFilter] ?? 'Mensual'
    if (_activityFilter === 'range' && _activityFrom && _activityTo) {
      _periodLabel = `Rango de fechas: ${_activityFrom} — ${_activityTo}`
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(120, 120, 120)
    doc.text(`Período: ${_periodLabel}`, 14, yC)
    doc.setTextColor(...DARK)
    yC += 5
    const tmpA = document.createElement('canvas')
    tmpA.width = activityCanvas.width; tmpA.height = activityCanvas.height
    const ctxA = tmpA.getContext('2d')
    ctxA.fillStyle = '#1A1A1A'; ctxA.fillRect(0, 0, tmpA.width, tmpA.height)
    ctxA.drawImage(activityCanvas, 0, 0)
    doc.addImage(tmpA.toDataURL('image/png'), 'PNG', 14, yC, 182, 100)
    yC += 112
  }

  // ── Graficos de dona (3 en fila con espacio generoso) ─────────────────────
  const _donuts = [
    { id: 'chart-status-lost',  label: 'Estado - Perros Extraviados' },
    { id: 'chart-status-found', label: 'Estado - Perros Encontrados' },
    { id: 'chart-users-status', label: 'Usuarios Activos vs Bloqueados' },
  ].map(d => ({ ...d, canvas: document.getElementById(d.id) })).filter(d => d.canvas)

  if (_donuts.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(...DARK)
    doc.text('Estado del Sistema', 14, yC)
    yC += 8
    const donutW = 70, donutH = 70
    const totalW = donutW * _donuts.length
    const gap = (182 - totalW) / (_donuts.length + 1)
    _donuts.forEach((d, i) => {
      const x = 14 + gap + i * (donutW + gap)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(40, 40, 40)
      doc.text(d.label, x + donutW / 2, yC, { align: 'center', maxWidth: donutW })
      const tmpD = document.createElement('canvas')
      tmpD.width = d.canvas.width; tmpD.height = d.canvas.height
      const ctxD = tmpD.getContext('2d')
      ctxD.fillStyle = '#1A1A1A'; ctxD.fillRect(0, 0, tmpD.width, tmpD.height)
      ctxD.drawImage(d.canvas, 0, 0)
      doc.addImage(tmpD.toDataURL('image/png'), 'PNG', x, yC + 5, donutW, donutH)
    })
  }

  // ── Grafico de permanencia ────────────────────────────────────────────────
  const permCanvas = document.getElementById('chart-permanencia')
  if (permCanvas) {
    doc.addPage()
    let yP = 20
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(...DARK)
    doc.text('Permanencia en el Refugio', 14, yP)
    yP += 6
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(...GRAY)
    doc.text('Solo tus reportes registrados  |  Dorado = aun activo  |  Verde = devuelto al dueno', 14, yP)
    yP += 7
    const tmpP = document.createElement('canvas')
    tmpP.width = permCanvas.width; tmpP.height = permCanvas.height
    const ctxP = tmpP.getContext('2d')
    ctxP.fillStyle = '#1A1A1A'; ctxP.fillRect(0, 0, tmpP.width, tmpP.height)
    ctxP.drawImage(permCanvas, 0, 0)
    doc.addImage(tmpP.toDataURL('image/png'), 'PNG', 14, yP, 182, 100)
  }

  // ── Nueva pagina para tablas de datos ─────────────────────────────────────
  doc.addPage()
  y = 20

  // ── Perros Extraviados ────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(...DARK)
  doc.text(`Perros Extraviados (${_lostDogsData.length} registros)`, 14, y)
  y += 5

  const lostRows = [..._lostDogsData]
    .sort((a, b) => (b.created_at?.toDate?.() ?? new Date(0)) - (a.created_at?.toDate?.() ?? new Date(0)))
    .map(d => [
      d.name        || 'N/A',
      d.owner_name  || 'N/A',
      d.owner_phone || 'N/A',
      d.color || d.color_principal || 'N/A',
      d.size  || d.tamaño || 'N/A',
      (!d.status || d.status === 'active') ? 'Activo' : 'Inactivo',
      d.created_at?.toDate?.()
        ? d.created_at.toDate().toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
        : 'N/A',
    ])

  doc.autoTable({
    startY: y,
    head: [['Nombre', 'Dueno', 'Telefono', 'Color', 'Tamano', 'Estado', 'Fecha']],
    body:  lostRows.length ? lostRows : [['Sin registros', '', '', '', '', '', '']],
    styles:            { fontSize: 8, cellPadding: 3 },
    headStyles:        { fillColor: DARK, textColor: GOLD, fontStyle: 'bold' },
    alternateRowStyles:{ fillColor: LGRAY },
    margin:            { left: 14, right: 14 },
    theme: 'grid',
  })

  y = doc.lastAutoTable.finalY + 12
  if (y > 240) { doc.addPage(); y = 20 }

  // ── Perros Encontrados ────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(...DARK)
  doc.text(`Perros Encontrados (${_foundReportsData.length} registros)`, 14, y)
  y += 5

  const foundRows = [..._foundReportsData]
    .sort((a, b) => (b.created_at?.toDate?.() ?? new Date(0)) - (a.created_at?.toDate?.() ?? new Date(0)))
    .map(d => {
      const matches = Array.isArray(d.matches) ? d.matches.filter(m => (m.similarity_percent ?? 0) >= 50).length : 0
      return [
        d.color  || 'N/A',
        d.size   || 'N/A',
        d.sex    || 'N/A',
        d.reporter_name  || 'N/A',
        d.reporter_phone || 'N/A',
        String(matches),
        (!d.status || d.status === 'active') ? 'Activo' : 'Inactivo',
        d.created_at?.toDate?.()
          ? d.created_at.toDate().toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
          : 'N/A',
      ]
    })

  doc.autoTable({
    startY: y,
    head: [['Color', 'Tamano', 'Sexo', 'Reportado por', 'Telefono', 'Coinc.>=50%', 'Estado', 'Fecha']],
    body:  foundRows.length ? foundRows : [['Sin registros', '', '', '', '', '', '', '']],
    styles:            { fontSize: 8, cellPadding: 3 },
    headStyles:        { fillColor: DARK, textColor: GOLD, fontStyle: 'bold' },
    alternateRowStyles:{ fillColor: LGRAY },
    margin:            { left: 14, right: 14 },
    theme: 'grid',
  })

  // ── Pie de pagina ─────────────────────────────────────────────────────────
  const pages = doc.internal.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setDrawColor(...GOLD)
    doc.setLineWidth(0.4)
    doc.line(14, 287, 196, 287)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...GRAY)
    doc.text('Refugio WOOF - Reporte generado automaticamente', 14, 292)
    doc.text(`Pagina ${i} de ${pages}`, 196, 292, { align: 'right' })
  }

  doc.save(`reporte-woof-${now.toISOString().slice(0, 10)}.pdf`)
}
