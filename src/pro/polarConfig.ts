/**
 * Configuración de Polar (merchant of record) para SessionKeeper Pro.
 *
 * Ninguno de estos valores es un secreto: el id de organización es público y el enlace de
 * pago está hecho para que lo abran los clientes. La clave de licencia del usuario nunca
 * vive aquí — va a `SecretStorage` de VS Code.
 *
 * Producto: "SessionKeeper Pro", pago único de 12 € (IVA incluido), benefit "SessionKeeper
 * Pro licence key" (prefijo SKP, nunca caduca, 3 activaciones, el cliente puede
 * desactivarlas). Creado el 2026-08-17; id del producto
 * c4f939dd-148d-4498-bff5-8dbe3825605e.
 *
 * Precio de lanzamiento: 7 € con el código LANZAMIENTO hasta el 2026-09-14. Cuando venza
 * hay que retirar el descuento en Polar y quitarlo del README el mismo día: un "precio de
 * lanzamiento" perpetuo es publicidad engañosa.
 */
export const POLAR_ORGANIZATION_ID = 'fa5605f8-f935-44c5-9923-686f9479d390';
export const POLAR_CHECKOUT_URL = 'https://buy.polar.sh/polar_cl_Bdh77ST0XOnVCLP3sDAM0lRFOKsWBVgQAzVNu3gW7PX';
export const PRO_PRICE_LABEL = '12 €';
export const PRO_LAUNCH_PRICE_LABEL = '7 €';
export const PRO_LAUNCH_CODE = 'LANZAMIENTO';
export const PRO_LAUNCH_ENDS = '2026-09-14';
export const PRO_INFO_URL = 'https://github.com/TecniartGalicia/sessionkeeper#pro';

/** Desbloqueo para desarrollo y CI: nunca dejarlo puesto en el entorno de un usuario. */
export const DEV_UNLOCK_ENV = 'SK_PRO_DEV';

export function polarConfigured(): boolean {
  return POLAR_ORGANIZATION_ID.trim().length > 0 && POLAR_CHECKOUT_URL.trim().length > 0;
}

/** ¿Sigue vigente el precio de lanzamiento? Se compara por fecha, no por confianza. */
export function launchPriceActive(now = new Date()): boolean {
  return now.toISOString().slice(0, 10) <= PRO_LAUNCH_ENDS;
}

/**
 * Etiqueta de precio que se muestra al usuario. La oferta caduca **por fecha, en el
 * código**: si un día nadie retira el cupón en Polar, la extensión deja igualmente de
 * anunciar un precio de lanzamiento que ya no toca. Vive aquí, y no en el servicio de
 * licencia, porque este módulo no depende de `vscode` y así se puede probar sin él.
 */
export function priceLabel(now = new Date()): string {
  return launchPriceActive(now) ? `${PRO_LAUNCH_PRICE_LABEL} (${PRO_LAUNCH_CODE})` : PRO_PRICE_LABEL;
}
