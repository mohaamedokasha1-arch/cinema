// Client for the server-side admin authentication API.
// The session itself lives in an HttpOnly cookie, so no token or password is
// ever stored or read by JavaScript.
async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, ok: response.ok, data };
}

export async function checkSession() {
  try {
    const { ok, data } = await request('/api/admin/session');
    if (ok && data) {
      return { available: true, authenticated: Boolean(data.authenticated), username: data.username || null };
    }
    return { available: false, authenticated: false, username: null };
  } catch {
    return { available: false, authenticated: false, username: null };
  }
}

export async function login(username, password) {
  try {
    const { status, ok, data } = await request('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (ok && data?.authenticated) return { success: true, username: data.username || username };
    if (status === 401) return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };
    if (status === 429) return { success: false, message: 'تم إيقاف المحاولات مؤقتًا بعد عدة محاولات غير صحيحة. حاول مرة أخرى بعد بضع دقائق.' };
    if (status === 503) return { success: false, message: 'خدمة الدخول غير مهيأة على الخادم. تواصل مع مسؤول الموقع لتفعيلها.' };
    if (status === 403) return { success: false, message: 'تعذّر التحقق من مصدر الطلب. أعد تحميل الصفحة وحاول مجددًا.' };
    return { success: false, message: 'تعذّر إكمال تسجيل الدخول. حاول مرة أخرى.' };
  } catch {
    return { success: false, message: 'خدمة الدخول غير متاحة حاليًا. تحقق من الاتصال بالشبكة أو من إعدادات الخادم.' };
  }
}

export async function logout() {
  try {
    await request('/api/admin/logout', { method: 'POST' });
  } catch {
    // The local UI state is cleared even if the request fails.
  }
}
