import * as assert from 'assert';
import { redact, scanText } from '../../core/secrets';

/**
 * Un aviso de credenciales que no detecta credenciales no sirve de nada, y uno que salta
 * con cualquier ruta temporal se ignora a la tercera. Las dos tablas se prueban a la vez.
 *
 * Los ejemplos se componen en tiempo de ejecución: escritos literales, la protección de
 * secretos de GitHub rechaza el push aunque sean inventados.
 */
const j = (...parts: string[]): string => parts.join('');
const DEBE_DETECTAR: Array<[string, string]> = [
  ['clave de AWS', j('AWS_ACCESS_KEY_ID=', 'AKIA', 'IOSFODNN7EXAMPLE')],
  ['token de GitHub', j('gh', 'p_', '016C7869B47C5C1234567890abcdefghijkl')],
  ['token fine-grained', j('github', '_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz123456')],
  ['clave de Anthropic', j('ANTHROPIC_API_KEY=', 'sk-', 'ant-', 'api03-AbCdEfGhIjKlMnOpQrStUvWx')],
  ['clave de OpenAI', j('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD')],
  ['token de Slack', j('xox', 'b-2345678901-2345678901234-AbCdEfGhIjKlMnOpQrStUvWx')],
  ['clave de Google', j('AIza', 'SyC1234567890abcdefghijklmnopqrstuvw')],
  ['clave de Stripe', j('sk', '_live', '_51AbCdEfGhIjKlMnOpQrStUvWx')],
  ['token de npm', j('npm', '_abcdefghijklmnopqrstuvwxyz0123456789')],
  ['clave privada', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ['JWT', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
  ['Authorization', 'Authorization: Bearer abcdef1234567890ABCDEF'],
  ['contraseña en URL', 'postgres://admin:Sup3rS3cret@db.example.com:5432/app'],
  ['minúsculas', 'password=Sup3rS3cretValue'],
  ['prefijo AWS_SECRET', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY'],
];

const NO_DEBE_SALTAR: Array<[string, string]> = [
  ['ruta temporal', 'C:\\Temp\\sk-backup-a1b2c3d4e5f6g7h8i9j0'],
  ['valor de ejemplo', 'pon tu API_KEY=tu-clave-aqui-de-ejemplo'],
  ['placeholder', 'SECRET_KEY=changeme-please'],
  ['prosa normal', 'el token caducó y hay que renovar la contraseña del panel'],
  ['ruta de proyecto', '/home/dev/sk-sessionkeeper/src/core/secrets.ts'],
];

describe('core/secrets', () => {
  for (const [nombre, texto] of DEBE_DETECTAR) {
    it(`detecta: ${nombre}`, () => {
      const hits = scanText(texto);
      assert.ok(hits.length > 0, `no detectó nada en: ${texto.slice(0, 40)}…`);
    });
  }

  for (const [nombre, texto] of NO_DEBE_SALTAR) {
    it(`no salta con: ${nombre}`, () => {
      assert.deepStrictEqual(scanText(texto), [], `falso positivo en: ${texto}`);
    });
  }

  it('nunca devuelve el valor encontrado', () => {
    const hits = scanText(j('gh', 'p_', '016C7869B47C5C1234567890abcdefghijkl'));
    assert.ok(hits.length === 1);
    assert.ok(!JSON.stringify(hits).includes('016C7869'), 'el informe no puede llevar el secreto');
  });

  it('la redacción sustituye el valor y deja el resto intacto', () => {
    const { text, hits } = redact(j('el token es ', 'gh', 'p_', '016C7869B47C5C1234567890abcdefghijkl', ' y ya está'));
    assert.ok(!text.includes(j('gh', 'p_', '016C7869')), text);
    assert.ok(text.startsWith('el token es '), text);
    assert.ok(text.endsWith(' y ya está'), text);
    assert.strictEqual(hits.length, 1);
  });
});
