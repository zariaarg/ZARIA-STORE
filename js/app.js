/* =============================================================
   ZARIA STORE — LÓGICA
   Se conecta al mismo backend (Apps Script) que usa Craft Flow.
   ============================================================= */

// El "/a/~/" evita un bug conocido de Google: si quien visita la
// página tiene más de una cuenta de Google logueada en el navegador,
// Google intenta redirigir la petición a una URL con "/u/N/" según
// cuál cuenta esté "activa" — y esa redirección a veces se rompe y
// devuelve 404, aunque el deployment esté en "Cualquier usuario".
// "/a/~/" fuerza el modo genérico/público y evita ese lío por completo.
const API_URL = "https://script.google.com/a/~/macros/s/AKfycbyZzZQhIyQAdZv2G4YqUqvb_wThnq_S_PPq81YET8W-vBVs7O9No7KOb1_stS2XbMvO/exec";
const EMPRESA_ID = 1;

// Token de tienda — lo exige el backend para leer el catálogo público
// y para crear pedidos. Es DISTINTO del token de administrador que
// usa Craft Flow: si alguien lo extrae de acá (es un archivo público,
// cualquiera puede verlo), como mucho puede leer el catálogo o mandar
// pedidos falsos — nunca acceso a datos de clientes ni al resto del
// sistema. Tiene que ser EXACTAMENTE el mismo valor que se cargó en
// el backend como TOKEN_TIENDA (Apps Script → Configuración del
// proyecto → Propiedades del script).
const API_TOKEN = "DLawfe-0xw7zL6C8CeIzDQwW57Grcu2eODs0xfCpsrY";

/* =========================================================
   ESTADO DE LA APLICACIÓN
   ========================================================= */

// ⚠️ VALORES DE REFERENCIA / PLACEHOLDER — reemplazar por las medidas
// reales una vez que estén tomadas. Mientras tanto sirven para que la
// tabla de talles funcione y se vea completa.
const TABLA_TALLES = {
    S: { cuello: 36, busto: 82, cintura: 66, alto: 40 },
    M: { cuello: 38, busto: 88, cintura: 72, alto: 42 },
    L: { cuello: 40, busto: 94, cintura: 78, alto: 44 }
};

const estado = {
    modelos: [],
    modelosFiltrados: [],
    filtroTipo: "todos",
    materiales: [],
    modeloMateriales: [],
    metodosPago: [],
    margenPct: 0,
    modeloActivo: null,
    materialesDefaultDelModelo: [],
    reemplazoPorCategoria: {},
    extrasSeleccionados: new Set(),
    // Estos dos ya no son "por modelo": tipoEntrega y datosCliente
    // se completan una sola vez para todo el pedido, en el carrito.
    tipoEntrega: "envio",
    carrito: [],
    editandoIndice: null,
    datosCliente: { nombre: "", telefono: "", email: "", direccion: "", observaciones: "", metodoPago: "" }
};


/* =========================================================
   UTILIDADES
   ========================================================= */

let contadorJsonp = 0;

function jsonpRequest(url) {
    return new Promise((resolve, reject) => {
        const nombreCallback = "zariaCallback_" + (contadorJsonp++);
        const script = document.createElement("script");
        const separador = url.includes("?") ? "&" : "?";
        script.src = url + separador + "callback=" + nombreCallback;

        const limpiar = () => {
            delete window[nombreCallback];
            script.remove();
        };

        window[nombreCallback] = data => {
            resolve(data);
            limpiar();
        };

        script.onerror = () => {
            reject(new Error("No se pudo conectar con la tienda. Probá de nuevo en un momento."));
            limpiar();
        };

        document.head.appendChild(script);
    });
}

async function obtenerRecurso(resource) {
    const url = `${API_URL}?resource=${resource}&empresa_id=${EMPRESA_ID}&token=${encodeURIComponent(API_TOKEN)}`;
    const respuesta = await jsonpRequest(url);
    if (!respuesta.success) {
        throw new Error(respuesta.error || "No se pudieron cargar los datos.");
    }
    return respuesta.data;
}

function convertirImagenDrive(url) {
    if (!url) {
        return "";
    }
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match) {
        return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1000`;
    }
    return url;
}

function formatearPrecio(numero) {
    return "$" + Math.round(Number(numero) || 0).toLocaleString("es-AR");
}

// Redondea al múltiplo de 1000 más cercano (ej: 65800 -> 66000). El
// backend hace lo mismo al crear el pedido — esto es solo para que el
// total que ve el cliente ACÁ, antes de mandar el pedido, ya coincida
// con lo que el backend va a cobrar de verdad.
function redondearAMil(valor) {
    return Math.round((Number(valor) || 0) / 1000) * 1000;
}

function escaparHTML(texto) {
    const div = document.createElement("div");
    div.textContent = texto == null ? "" : String(texto);
    return div.innerHTML;
}


/* =========================================================
   CARGA INICIAL
   ========================================================= */

async function iniciar() {
    const grid = document.getElementById("catalogo-grid");

    try {
        const [modelos, materiales, modeloMateriales, configuracion, configSistema, empresas] = await Promise.all([
            obtenerRecurso("modelos"),
            obtenerRecurso("materiales"),
            obtenerRecurso("modelo_materiales"),
            obtenerRecurso("configuracion"),
            obtenerRecurso("config_sistema"),
            obtenerRecurso("empresas")
        ]);

        estado.modelos = modelos.filter(m => String(m.activo).toUpperCase() === "TRUE");
        estado.materiales = materiales.filter(m => String(m.activo).toUpperCase() === "TRUE");
        estado.modeloMateriales = modeloMateriales;

        estado.metodosPago = configuracion.filter(
            c => c.categoria === "METODO_PAGO" && String(c.activo).toUpperCase() === "TRUE"
        );

        const filaMargen = configSistema.find(
            c => String(c.parametro || "").trim().toUpperCase() === "MARGEN_PERSONALIZACION"
        );
        estado.margenPct = filaMargen ? Number(filaMargen.valor || 0) : 0;

        const empresa = empresas.find(e => Number(e.empresa_id) === EMPRESA_ID);
        if (empresa && empresa.logo) {
            const logoUrl = convertirImagenDrive(empresa.logo);

            const logo = document.getElementById("marca-logo");
            logo.src = logoUrl;
            logo.hidden = false;

            document.getElementById("favicon").href = logoUrl;
        }

        renderizarFiltros();
        renderizarCatalogo();

    } catch (error) {
        console.error(error);
        grid.innerHTML = `<p class="estado-error">${escaparHTML(error.message)}</p>`;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    iniciar();

    document.getElementById("btn-cerrar-talles").addEventListener("click", () => {
        document.getElementById("talles-overlay").hidden = true;
    });

    document.getElementById("btn-cerrar-info").addEventListener("click", () => {
        document.getElementById("info-overlay").hidden = true;
    });

    document.getElementById("info-overlay").addEventListener("click", function(evento) {
        if (evento.target === this) {
            this.hidden = true;
        }
    });

    document.querySelectorAll(".footer-link").forEach(boton => {
        boton.addEventListener("click", () => {
            abrirInfo(boton.dataset.info);
            document.getElementById("menu-mas-info").hidden = true;
            document.getElementById("btn-mas-info").classList.remove("abierto");
        });
    });

    const botonMasInfo = document.getElementById("btn-mas-info");
    const menuMasInfo = document.getElementById("menu-mas-info");

    botonMasInfo.addEventListener("click", function(evento) {
        evento.stopPropagation();
        const abierto = !menuMasInfo.hidden;
        menuMasInfo.hidden = abierto;
        botonMasInfo.classList.toggle("abierto", !abierto);
    });

    document.addEventListener("click", function(evento) {
        if (!menuMasInfo.hidden && !menuMasInfo.contains(evento.target) && evento.target !== botonMasInfo) {
            menuMasInfo.hidden = true;
            botonMasInfo.classList.remove("abierto");
        }
    });

    document.getElementById("btn-carrito").addEventListener("click", () => {
        abrirCarrito();
    });

    document.getElementById("btn-cerrar-carrito").addEventListener("click", () => {
        document.getElementById("carrito-overlay").hidden = true;
    });

    document.getElementById("carrito-overlay").addEventListener("click", function(evento) {
        if (evento.target === this) {
            this.hidden = true;
        }
    });
});


/* =========================================================
   INFORMACIÓN (Quiénes somos / Cuidados / Envíos / Cambios / Contacto)
   ========================================================= */

const CONTENIDO_INFO = {

    "quienes-somos": `
        <h2>Quiénes somos</h2>
        <p>ZARIA nació haciendo crochet — con cariño, despacio, pieza por pieza. Con el tiempo empezamos a sumar cuero, después denim, y hoy el cuero se convirtió en el protagonista de todo lo que hacemos.</p>
        <p>Creemos en la artesanía como una forma de crear piezas con identidad, tiempo y dedicación. Nuestro nombre representa ese espíritu: el valor de lo auténtico, de lo hecho a mano y de aquello que perdura.</p>
        <p>Cada prenda se arma después de tu pedido — vos elegís el material, el color, los detalles. Nada sale del taller sin que lo hayas decidido vos.</p>
        <p><em>Cuero auténtico. Trabajo artesanal. Diseño con identidad.</em></p>
    `,

    "esencia": `
        <h2>Nuestra esencia</h2>
        <p><em>En ZARIA creemos en la artesanía como una forma de crear piezas con identidad, tiempo y dedicación. Nuestro nombre representa ese espíritu: el valor de lo auténtico, de lo hecho a mano y de aquello que perdura.</em></p>
        <p class="info-firma">Cuero auténtico. Trabajo artesanal. Diseño con identidad.</p>
    `,

    "cuidados": `
        <h2>Cuidados de tu prenda</h2>
        <p>Cada pieza está confeccionada artesanalmente con cuero, crochet y/o denim. Con los cuidados adecuados, te va a acompañar durante muchos años.</p>

        <h3>Recomendaciones generales</h3>
        <ul>
            <li>Limpiá únicamente la zona necesaria, con un paño suave apenas humedecido.</li>
            <li>No laves en lavarropas, ni retuerzas ni centrifugues la prenda.</li>
            <li>No uses lavandina ni productos abrasivos.</li>
            <li>No seques al sol directo ni con secadora — dejá secar siempre a temperatura ambiente.</li>
            <li>Guardá la prenda en un lugar seco y ventilado.</li>
        </ul>

        <div class="cuidado-categoria">
            <div class="cuidado-categoria-titulo">
                <span class="cuidado-icono">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M8 3h3l0.6 3L12 3h3l1 8.5-0.6 9.5H14l-1-7-1 7H9l-0.6-9.5L9 3Z"/>
                        <path d="M10 8h1M13 8h1"/>
                    </svg>
                </span>
                <h3>Denim</h3>
            </div>
            <ul>
                <li>Lavalo del revés, con agua fría.</li>
                <li>Evitá lavados frecuentes, para conservar mejor el color.</li>
                <li>Secalo al aire.</li>
            </ul>
        </div>

        <div class="cuidado-categoria">
            <div class="cuidado-categoria-titulo">
                <span class="cuidado-icono">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 3c3 0 5 2 5 4 1 0 3 1.3 3 3.3s-2 2.7-2 4c1 1.2.8 3-1 4-1 2-3 2-5 2s-4 0-5-2c-1.8-1-2-2.8-1-4 0-1.3-2-2-2-4S6 7 7 7c0-2 2-4 5-4Z"/>
                        <path d="M9.5 9.5c1 1.2 1 3.8 0 6M14.5 9.5c-1 1.2-1 3.8 0 6"/>
                    </svg>
                </span>
                <h3>Cuero y gamuza</h3>
            </div>
            <ul>
                <li>Evitá el contacto con agua y otros líquidos — la gamuza en particular los absorbe con facilidad. Si se humedece, dejala secar naturalmente, lejos del sol y de cualquier fuente de calor.</li>
                <li>Para protegerla, podés aplicar un impermeabilizante específico para gamuza antes de usarla por primera vez.</li>
                <li>Eliminá el polvo con un cepillo para gamuza o un paño suave.</li>
                <li>Ante una mancha de grasa, aplicá talco o fécula de maíz, dejá actuar unas horas y retiralo con un cepillo.</li>
                <li>Si se derrama un líquido, absorbelo con papel o un paño limpio, sin frotar.</li>
                <li>En cueros lisos (napa) o croco, alcanza con un paño suave apenas húmedo — evitá alcohol o solventes, y guardalos sin doblar en exceso para no marcar el relieve.</li>
            </ul>
        </div>

        <div class="cuidado-categoria">
            <div class="cuidado-categoria-titulo">
                <span class="cuidado-icono">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="9.5" cy="9.5" r="3.2"/>
                        <circle cx="15" cy="9.5" r="3.2"/>
                        <circle cx="9.5" cy="15" r="3.2"/>
                        <circle cx="15" cy="15" r="3.2"/>
                    </svg>
                </span>
                <h3>Crochet</h3>
            </div>
            <ul>
                <li>Lavar a mano con agua fría y jabón neutro.</li>
                <li>Secar extendido sobre una superficie plana.</li>
                <li>No colgar mojado, para evitar que se estire.</li>
            </ul>
        </div>

        <p>Para una limpieza profunda de cualquiera de estos materiales, recomendamos acudir a una tintorería especializada en cuero.</p>
    `,

    "envios": `
        <h2>Envíos</h2>
        <p>El costo de envío se calcula una vez confirmado tu pedido, según tu ubicación — te lo vamos a informar antes de coordinar el pago final.</p>
        <p>Hacemos envíos a todo el país a través de la empresa de transporte que mejor se ajuste a tu zona. Una vez despachado tu pedido, te pasamos el número de seguimiento para que puedas hacerle el seguimiento vos misma.</p>
        <p>Si preferís, también podés retirar tu pedido en persona — coordinamos el lugar y el horario por mensaje.</p>
        <p>Una vez que el paquete sale de nuestras manos, queda a cargo de la empresa transportadora. Ante una eventual pérdida, robo o daño durante el traslado, te acompañamos en el reclamo correspondiente ante el correo, aunque la resolución final depende de la política de esa empresa. Te recomendamos revisar el estado del paquete al recibirlo, y avisarnos dentro de las 24 horas si notás algún problema.</p>
    `,

    "cambios": `
        <h2>Cambios y devoluciones</h2>
        <p>Cada pieza está hecha a mano, con dedicación y tiempo. Calculá entre 5 y 10 días hábiles desde la confirmación de tu pedido hasta que esté lista para el envío, ya que se confecciona especialmente para vos.</p>
        <p>Como trabajamos con cuero genuino, cada prenda puede presentar variaciones naturales de textura, veta o tono respecto a las fotos — es parte de lo que hace única a cada pieza, no un defecto.</p>

        <h3>Devoluciones</h3>
        <p>Por tratarse de piezas hechas a pedido, no aceptamos devoluciones de productos sin falla.</p>
        <p>Si necesitás cambiar el talle o alguna medida, tenés 15 días desde que recibís tu pedido para solicitarlo. Aceptamos el cambio siempre que la prenda llegue sin uso, en su empaque original.</p>

        <h3>¿Cómo pedir un cambio de talle o medida?</h3>
        <p>Escribinos a <a href="mailto:zaria.arg@gmail.com">zaria.arg@gmail.com</a> indicando el número de pedido y qué querés cambiar. Te vamos a contactar a la brevedad para coordinar los pasos siguientes.</p>

        <h3>Fallas de fabricación</h3>
        <p>Si tu prenda llega con una falla de fabricación, escribinos a <a href="mailto:zaria.arg@gmail.com">zaria.arg@gmail.com</a> con una foto del problema — lo vamos a evaluar y coordinar la solución.</p>
        <p>No se consideran fallas de fabricación: el desgaste por uso, roturas o manchas por mal cuidado, ni daños por exposición a agua, calor o productos no recomendados (ver <button type="button" class="info-link-interno" data-info="cuidados">Cuidados de tu prenda</button>).</p>

        <h3>Costos de envío en cambios</h3>
        <p>Si el cambio es por una falla de fabricación, el costo de envío corre por nuestra cuenta. Si es por un cambio de talle o medida sin falla, el envío de vuelta corre por cuenta del comprador.</p>
    `,

    "contacto": `
        <h2>Contacto</h2>
        <p>¿Tenés dudas sobre un modelo, tu pedido o cómo personalizarlo? Escribinos, con gusto te ayudamos.</p>
        <ul class="info-contacto-lista">
            <li>
                <a href="https://instagram.com/zaria.arg" target="_blank" rel="noopener">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="3.5"/><circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" stroke="none"/></svg>
                    @zaria.arg
                </a>
            </li>
            <li>
                <a href="mailto:zaria.arg@gmail.com">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
                    zaria.arg@gmail.com
                </a>
            </li>
            <li>
                <a href="https://wa.me/5491153131633" target="_blank" rel="noopener">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20l1.3-4.2A8 8 0 1 1 8.7 19L4 20Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5"/></svg>
                    +54 9 11 5313-1633
                </a>
            </li>
        </ul>
    `

};

function abrirInfo(tipo) {
    const contenido = CONTENIDO_INFO[tipo];
    if (!contenido) {
        return;
    }

    document.getElementById("info-contenido").innerHTML = contenido;
    document.getElementById("info-overlay").hidden = false;

    document.querySelectorAll(".info-link-interno").forEach(boton => {
        boton.addEventListener("click", () => abrirInfo(boton.dataset.info));
    });
}


/* =========================================================
   CATÁLOGO
   ========================================================= */

function renderizarFiltros() {
    const contenedor = document.getElementById("catalogo-filtros");
    const tipos = [...new Set(estado.modelos.map(m => m.tipo).filter(Boolean))];

    if (!tipos.length) {
        contenedor.innerHTML = "";
        return;
    }

    const opciones = ["todos", ...tipos];

    contenedor.innerHTML = opciones.map(tipo => `
        <button type="button" class="filtro-tipo ${tipo === estado.filtroTipo ? "activo" : ""}" data-tipo="${escaparHTML(tipo)}">
            ${tipo === "todos" ? "Todos" : escaparHTML(tipo.charAt(0) + tipo.slice(1).toLowerCase())}
        </button>
    `).join("");

    contenedor.querySelectorAll(".filtro-tipo").forEach(boton => {
        boton.addEventListener("click", () => {
            estado.filtroTipo = boton.dataset.tipo;
            renderizarFiltros();
            renderizarCatalogo();
        });
    });
}

function renderizarCatalogo() {
    const grid = document.getElementById("catalogo-grid");

    const modelos = estado.filtroTipo === "todos"
        ? estado.modelos
        : estado.modelos.filter(m => m.tipo === estado.filtroTipo);

    if (!modelos.length) {
        grid.innerHTML = `<p class="estado-carga">No hay modelos en esta categoría todavía.</p>`;
        return;
    }

    grid.innerHTML = modelos.map(modelo => `
        <button type="button" class="modelo-card" data-modelo-id="${modelo.modelo_id}">
            <div class="modelo-card-imagen">
                <img class="img-principal" src="${convertirImagenDrive(modelo.imagen)}" alt="${escaparHTML(modelo.nombre)}" loading="lazy">
                ${modelo.imagen_2 ? `<img class="img-secundaria" src="${convertirImagenDrive(modelo.imagen_2)}" alt="" loading="lazy">` : ""}
            </div>
            <div class="modelo-card-info">
                <div class="modelo-card-tipo">${escaparHTML(modelo.tipo || "")}</div>
                <div class="modelo-card-nombre">${escaparHTML(modelo.nombre)}</div>
                <div class="modelo-card-precio">${formatearPrecio(modelo.precio_venta)}</div>
            </div>
        </button>
    `).join("");

    grid.querySelectorAll(".modelo-card").forEach(card => {
        card.addEventListener("click", () => {
            const modeloId = Number(card.dataset.modeloId);
            const modelo = estado.modelos.find(m => Number(m.modelo_id) === modeloId);
            if (modelo) {
                abrirFicha(modelo);
            }
        });
    });
}


/* =========================================================
   FICHA / PANEL DE PERSONALIZACIÓN
   ========================================================= */

function buscarMaterial(materialId) {
    return estado.materiales.find(m => Number(m.material_id) === Number(materialId));
}

function alternativasPara(materialDefault) {
    return estado.materiales.filter(m =>
        m.categoria === materialDefault.categoria &&
        m.unidad_compra === materialDefault.unidad_compra &&
        Number(m.material_id) !== Number(materialDefault.material_id)
    );
}

function abrirFicha(modelo, valoresGuardados) {
    estado.modeloActivo = modelo;

    estado.materialesDefaultDelModelo = estado.modeloMateriales
        .filter(item => Number(item.modelo_id) === Number(modelo.modelo_id))
        .map(item => ({ ...item, material: buscarMaterial(item.material_id) }))
        .filter(item => item.material);

    if (valoresGuardados) {
        // Estamos editando un ítem que ya estaba en el carrito — partimos
        // de su configuración guardada en vez de arrancar en blanco.
        // reemplazos viene como [{material_default_id, material_elegido_id}],
        // pero el estado interno lo indexa por categoría — lo convertimos.
        const reemplazoPorCategoria = {};
        (valoresGuardados.reemplazos || []).forEach(r => {
            const materialDefault = buscarMaterial(r.material_default_id);
            if (materialDefault) {
                reemplazoPorCategoria[materialDefault.categoria] = String(r.material_elegido_id);
            }
        });
        estado.reemplazoPorCategoria = reemplazoPorCategoria;
        estado.extrasSeleccionados = new Set((valoresGuardados.extras || []).map(String));
    } else {
        estado.reemplazoPorCategoria = {};
        estado.extrasSeleccionados = new Set();
    }

    const contenido = document.getElementById("panel-contenido");
    contenido.innerHTML = construirHTMLFicha(modelo);

    cablearEventosFicha();

    if (valoresGuardados) {
        const inputColorHilo = document.getElementById("input-color-hilo");
        if (inputColorHilo) inputColorHilo.value = valoresGuardados.color_hilo || "";
        document.getElementById("input-talle").value = valoresGuardados.talle || "";
        document.getElementById("input-cuello").value = valoresGuardados.cuello || "";
        document.getElementById("input-busto").value = valoresGuardados.busto || "";
        document.getElementById("input-cintura").value = valoresGuardados.cintura || "";
        document.getElementById("input-alto").value = valoresGuardados.alto || "";
    }

    actualizarTotal();

    document.getElementById("panel-overlay").hidden = false;
}

function construirHTMLFicha(modelo) {
    // Agrupamos los defaults por categoría (CUERO_TELA / HEBILLA): si un
    // modelo tiene más de un material default de la misma categoría,
    // mostramos un solo selector de swatches para esa categoría — antes
    // se repetía un bloque por cada fila default, que se veía como
    // "los mismos círculos 3 veces".
    const categoriasConReemplazo = {};
    estado.materialesDefaultDelModelo.forEach(item => {
        const cat = item.material.categoria;
        if (cat !== "CUERO_TELA" && cat !== "HEBILLA") {
            return;
        }
        if (!categoriasConReemplazo[cat]) {
            categoriasConReemplazo[cat] = { categoria: cat, primerDefault: item.material, defaults: [] };
        }
        categoriasConReemplazo[cat].defaults.push(item.material);
    });

    const tieneHilo = estado.materialesDefaultDelModelo.some(
        item => item.material.categoria === "HILO"
    );

    const extrasDisponibles = estado.materiales.filter(m => m.categoria === "EXTRA");

    const bloquesReemplazo = Object.values(categoriasConReemplazo).map(grupo => {
        const alternativas = alternativasPara(grupo.primerDefault);
        if (!alternativas.length) {
            return "";
        }

        const opciones = [grupo.primerDefault, ...alternativas];
        const etiqueta = grupo.categoria === "HEBILLA" ? "Hebilla" : "Material principal";
        const yaElegido = estado.reemplazoPorCategoria[grupo.categoria];

        return `
            <div class="campo" data-categoria="${grupo.categoria}">
                <span class="campo-titulo">${escaparHTML(etiqueta)} — por defecto: ${escaparHTML(grupo.defaults.map(d => d.nombre).join(" / "))}</span>
                <div class="swatches">
                    ${opciones.map((op, i) => {
                        const activo = yaElegido ? String(yaElegido) === String(op.material_id) : i === 0;
                        return `
                        <button type="button" class="swatch ${activo ? "activo" : ""}" data-material-id="${op.material_id}" data-categoria="${grupo.categoria}">
                            <img src="${convertirImagenDrive(op.imagen_muestra) || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"}" alt="${escaparHTML(op.nombre)}" onerror="this.style.background='var(--tarjeta)'">
                            <span class="swatch-nombre">${escaparHTML(op.nombre)}</span>
                        </button>
                    `;
                    }).join("")}
                </div>
            </div>
        `;
    }).join("");

    const bloqueHilo = tieneHilo ? `
        <div class="campo">
            <span class="campo-titulo">Color de hilo</span>
            <input type="text" id="input-color-hilo" placeholder="Ej: turquesa, bordó, mostaza...">
        </div>
    ` : "";

    const bloqueExtras = extrasDisponibles.length ? `
        <div class="campo">
            <span class="campo-titulo">Sumar extras</span>
            <div class="extras-lista">
                ${extrasDisponibles.map(extra => `
                    <label class="extra-item">
                        <input type="checkbox" class="check-extra" value="${extra.material_id}" ${estado.extrasSeleccionados.has(String(extra.material_id)) ? "checked" : ""}>
                        ${extra.imagen_muestra ? `<img class="extra-imagen" src="${convertirImagenDrive(extra.imagen_muestra)}" alt="">` : ""}
                        ${escaparHTML(extra.nombre)}
                    </label>
                `).join("")}
            </div>
        </div>
    ` : "";

    return `
        <div class="ficha-imagen">
            <img src="${convertirImagenDrive(modelo.imagen)}" alt="${escaparHTML(modelo.nombre)}">
        </div>
        <div class="ficha-detalle">
            <div>
                <div class="ficha-tipo">${escaparHTML(modelo.tipo || "")}</div>
                <h2 id="panel-titulo" class="ficha-nombre">${escaparHTML(modelo.nombre)}</h2>
            </div>

            ${modelo.descripcion ? `<p class="ficha-descripcion">${escaparHTML(modelo.descripcion)}</p>` : ""}

            ${bloquesReemplazo}
            ${bloqueHilo}
            ${bloqueExtras}

            <div class="campo">
                <div class="campo-titulo-fila">
                    <span class="campo-titulo">Talle</span>
                    <button type="button" id="btn-ver-talles" class="link-tabla-talles">Ver tabla de talles</button>
                </div>
                <input type="text" id="input-talle" placeholder="Ej: S, M, L, Único">
            </div>

            <div class="campo">
                <span class="campo-titulo">¿Preferís que te lo hagamos a medida?</span>
                <div class="form-grid">
                    <input type="text" id="input-cuello" placeholder="Cuello (cm)">
                    <input type="text" id="input-busto" placeholder="Busto (cm)">
                    <input type="text" id="input-cintura" placeholder="Cintura (cm)">
                    <input type="text" id="input-alto" placeholder="Alto (cm)">
                </div>
            </div>

            <div class="ficha-total">
                <div>
                    <div class="ficha-total-label">Total</div>
                    <div id="ficha-total-valor" class="ficha-total-valor">${formatearPrecio(modelo.precio_venta)}</div>
                </div>
                <button type="button" id="btn-agregar-carrito" class="btn btn-primary">Agregar al carrito</button>
            </div>
        </div>
    `;
}

function cablearEventosFicha() {
    document.querySelectorAll(".swatch").forEach(swatch => {
        swatch.addEventListener("click", () => {
            const categoria = swatch.dataset.categoria;
            const materialId = swatch.dataset.materialId;

            document.querySelectorAll(`.swatch[data-categoria="${categoria}"]`).forEach(s => {
                s.classList.remove("activo");
            });
            swatch.classList.add("activo");

            estado.reemplazoPorCategoria[categoria] = materialId;
            actualizarTotal();
        });
    });

    document.querySelectorAll(".check-extra").forEach(checkbox => {
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                estado.extrasSeleccionados.add(checkbox.value);
            } else {
                estado.extrasSeleccionados.delete(checkbox.value);
            }
            actualizarTotal();
        });
    });

    document.getElementById("btn-agregar-carrito").addEventListener("click", agregarAlCarrito);
    document.getElementById("btn-cerrar-panel").addEventListener("click", cerrarPanel);
    document.getElementById("btn-ver-talles").addEventListener("click", abrirTablaTalles);
}

function abrirTablaTalles() {
    const cuerpo = document.getElementById("tabla-talles-body");
    cuerpo.innerHTML = Object.entries(TABLA_TALLES).map(([talle, medidas]) => `
        <tr>
            <td>${escaparHTML(talle)}</td>
            <td>${medidas.cuello}</td>
            <td>${medidas.busto}</td>
            <td>${medidas.cintura}</td>
            <td>${medidas.alto}</td>
        </tr>
    `).join("");
    document.getElementById("talles-overlay").hidden = false;
}

function cerrarPanel() {
    document.getElementById("panel-overlay").hidden = true;

    // Si veníamos de "Editar" un ítem del carrito y se cierra la ficha
    // sin guardar (botón ✕), cancelamos la edición y volvemos al
    // carrito — el ítem original queda como estaba, sin cambios.
    if (estado.editandoIndice !== null && estado.editandoIndice !== undefined) {
        estado.editandoIndice = null;
        abrirCarrito();
    }
}


/* =========================================================
   CÁLCULO DE PRECIO (en vivo, mismo criterio que el backend)
   ========================================================= */

function calcularRecargoEnVivo() {
    const factorMargen = 1 + (estado.margenPct / 100);
    let recargo = 0;

    estado.materialesDefaultDelModelo.forEach(item => {
        const elegidoId = estado.reemplazoPorCategoria[item.material.categoria];
        if (!elegidoId) {
            return;
        }
        const elegido = buscarMaterial(elegidoId);
        if (!elegido || Number(elegido.material_id) === Number(item.material.material_id)) {
            return;
        }
        const diferenciaCosto = Number(elegido.costo_unitario || 0) - Number(item.material.costo_unitario || 0);
        recargo += diferenciaCosto * Number(item.cantidad || 0) * factorMargen;
    });

    estado.extrasSeleccionados.forEach(materialId => {
        const extra = buscarMaterial(materialId);
        if (!extra) {
            return;
        }
        const cantidadExtra = Number(extra.cantidad_extra || 1);
        recargo += Number(extra.costo_unitario || 0) * cantidadExtra * factorMargen;
    });

    return recargo;
}

function actualizarTotal() {
    if (!estado.modeloActivo) {
        return;
    }
    const total = redondearAMil(Number(estado.modeloActivo.precio_venta || 0) + calcularRecargoEnVivo());
    const elemento = document.getElementById("ficha-total-valor");
    if (elemento) {
        elemento.textContent = formatearPrecio(total);
    }
}


/* =========================================================
   CARRITO — agregar / quitar / renderizar
   ========================================================= */

function actualizarContadorCarrito() {
    const contador = document.getElementById("carrito-contador");
    const cantidad = estado.carrito.length;
    contador.textContent = cantidad;
    contador.hidden = cantidad === 0;
}

// Toma la configuración actual de la ficha abierta (modelo, reemplazos,
// extras, talle/medidas, color de hilo) y la "congela" como un ítem
// más del carrito — de acá en más este ítem ya no depende de
// estado.reemplazoPorCategoria ni de estado.extrasSeleccionados, que
// se reinician la próxima vez que se abra otra ficha.
function agregarAlCarrito() {
    if (!estado.modeloActivo) {
        return;
    }

    const inputColorHilo = document.getElementById("input-color-hilo");
    const colorHilo = inputColorHilo ? inputColorHilo.value.trim() : "";
    const talle = document.getElementById("input-talle").value.trim();
    const cuello = document.getElementById("input-cuello").value.trim();
    const busto = document.getElementById("input-busto").value.trim();
    const cintura = document.getElementById("input-cintura").value.trim();
    const alto = document.getElementById("input-alto").value.trim();

    const reemplazos = [];
    const nombresPersonalizacion = [];

    estado.materialesDefaultDelModelo.forEach(item => {
        const elegidoId = estado.reemplazoPorCategoria[item.material.categoria];
        if (elegidoId && String(elegidoId) !== String(item.material.material_id)) {
            reemplazos.push({
                material_default_id: Number(item.material.material_id),
                material_elegido_id: Number(elegidoId)
            });
            const elegido = buscarMaterial(elegidoId);
            if (elegido) {
                nombresPersonalizacion.push(elegido.nombre);
            }
        }
    });

    const extras = Array.from(estado.extrasSeleccionados).map(Number);
    const nombresExtras = extras
        .map(id => buscarMaterial(id))
        .filter(Boolean)
        .map(m => m.nombre);

    const precioFinal = redondearAMil(Number(estado.modeloActivo.precio_venta || 0) + calcularRecargoEnVivo());

    // Resumen legible para mostrar en la lista del carrito.
    const partesResumen = [];
    if (nombresPersonalizacion.length) partesResumen.push(nombresPersonalizacion.join(", "));
    if (colorHilo) partesResumen.push("Hilo " + colorHilo);
    if (talle) partesResumen.push("Talle " + talle);
    if (nombresExtras.length) partesResumen.push("+ " + nombresExtras.join(", "));

    const itemConfigurado = {
        modelo_id: Number(estado.modeloActivo.modelo_id),
        modelo_nombre: estado.modeloActivo.nombre,
        modelo_imagen: estado.modeloActivo.imagen,
        color_hilo: colorHilo,
        talle: talle,
        cuello: cuello,
        busto: busto,
        cintura: cintura,
        alto: alto,
        reemplazos: reemplazos,
        extras: extras,
        precio_final: precioFinal,
        resumen: partesResumen.join(" · ") || "Configuración por defecto"
    };

    const estabaEditando = estado.editandoIndice !== null && estado.editandoIndice !== undefined;

    if (estabaEditando) {
        // Actualizamos el ítem existente in-place, conservando la
        // cantidad que ya tenía — editar la personalización no debería
        // resetear cuántas piezas había pedido.
        const cantidadPrevia = estado.carrito[estado.editandoIndice].cantidad || 1;
        estado.carrito[estado.editandoIndice] = { ...itemConfigurado, cantidad: cantidadPrevia };
        estado.editandoIndice = null;
    } else {
        estado.carrito.push({ ...itemConfigurado, cantidad: 1 });
    }

    actualizarContadorCarrito();
    cerrarPanel();

    // Si veníamos del carrito (editando), volvemos ahí — si era un
    // modelo nuevo desde el catálogo, cerrarPanel ya deja ver el
    // catálogo de fondo, que es donde corresponde quedarse.
    if (estabaEditando) {
        abrirCarrito();
    }
}

function editarItemCarrito(indice) {
    const item = estado.carrito[indice];
    if (!item) {
        return;
    }

    const modelo = estado.modelos.find(m => Number(m.modelo_id) === Number(item.modelo_id));
    if (!modelo) {
        mostrarErrorCarrito("Ese modelo ya no está disponible para editar — podés quitarlo y elegir otro del catálogo.");
        return;
    }

    estado.editandoIndice = indice;
    document.getElementById("carrito-overlay").hidden = true;
    abrirFicha(modelo, item);
}

function abrirCarrito() {
    renderizarCarrito();
    document.getElementById("carrito-overlay").hidden = false;
}

function renderizarCarrito() {
    document.getElementById("carrito-contenido").innerHTML = construirHTMLCarrito();
    cablearEventosCarrito();
}

function construirHTMLCarrito() {
    if (!estado.carrito.length) {
        return `
            <h2 id="carrito-titulo" class="carrito-titulo">Tu carrito</h2>
            <p class="carrito-vacio">Todavía no agregaste ninguna pieza. Elegí un modelo del catálogo para empezar.</p>
        `;
    }

    const totalGeneral = estado.carrito.reduce((acumulado, item) => acumulado + item.precio_final * (item.cantidad || 1), 0);
    const totalPiezas = estado.carrito.reduce((acumulado, item) => acumulado + (item.cantidad || 1), 0);
    const datos = estado.datosCliente;

    const itemsHTML = estado.carrito.map((item, indice) => `
        <div class="carrito-item">
            <div class="carrito-item-imagen">
                <img src="${convertirImagenDrive(item.modelo_imagen)}" alt="${escaparHTML(item.modelo_nombre)}">
            </div>
            <div class="carrito-item-info">
                <div class="carrito-item-nombre">${escaparHTML(item.modelo_nombre)}</div>
                <div class="carrito-item-resumen">${escaparHTML(item.resumen)}</div>
                <div class="carrito-item-precio">${formatearPrecio(item.precio_final * (item.cantidad || 1))}</div>
                <div class="carrito-item-acciones">
                    <div class="carrito-item-cantidad">
                        <button type="button" class="cantidad-btn" data-indice="${indice}" data-delta="-1" aria-label="Restar una unidad">−</button>
                        <span class="cantidad-valor">${item.cantidad || 1}</span>
                        <button type="button" class="cantidad-btn" data-indice="${indice}" data-delta="1" aria-label="Sumar una unidad">+</button>
                    </div>
                    <button type="button" class="carrito-item-editar" data-indice="${indice}">Editar</button>
                </div>
            </div>
            <button type="button" class="carrito-item-quitar" data-indice="${indice}" aria-label="Quitar del carrito">✕</button>
        </div>
    `).join("");

    return `
        <h2 id="carrito-titulo" class="carrito-titulo">Tu carrito</h2>
        <div class="carrito-lista">${itemsHTML}</div>

        <div class="campo">
            <span class="campo-titulo">Entrega</span>
            <div class="entrega-opciones">
                <label><input type="radio" name="carrito-entrega" value="envio" ${estado.tipoEntrega === "envio" ? "checked" : ""}> Envío</label>
                <label><input type="radio" name="carrito-entrega" value="retiro" ${estado.tipoEntrega === "retiro" ? "checked" : ""}> Retiro en persona</label>
            </div>
        </div>

        <div class="campo">
            <span class="campo-titulo">Tus datos</span>
            <div class="form-grid">
                <input type="text" id="carrito-input-nombre" placeholder="Nombre y apellido" class="campo-full" value="${escaparHTML(datos.nombre)}">
                <input type="tel" id="carrito-input-telefono" placeholder="Teléfono" value="${escaparHTML(datos.telefono)}">
                <input type="email" id="carrito-input-email" placeholder="Email (opcional)" value="${escaparHTML(datos.email)}">
                <input type="text" id="carrito-input-direccion" class="campo-full campo-direccion" value="${escaparHTML(datos.direccion)}"
                    placeholder="${estado.tipoEntrega === "envio" ? "Dirección de envío" : "Dirección (opcional)"}">
            </div>
        </div>

        <div class="campo">
            <span class="campo-titulo">¿Algo más que quieras decirnos? (opcional)</span>
            <textarea id="carrito-input-observaciones" rows="3" placeholder="Alguna aclaración sobre tu pedido...">${escaparHTML(datos.observaciones)}</textarea>
        </div>

        <div class="campo">
            <span class="campo-titulo">Método de pago</span>
            <select id="carrito-input-metodo-pago">
                <option value="">Elegí una opción</option>
                ${estado.metodosPago.map(m => `<option value="${escaparHTML(m.valor)}" ${datos.metodoPago === m.valor ? "selected" : ""}>${escaparHTML(m.valor)}</option>`).join("")}
            </select>
        </div>

        <p id="carrito-mensaje-error" class="mensaje-error" hidden></p>

        <div class="ficha-total">
            <div>
                <div class="ficha-total-label">Total (${totalPiezas} ${totalPiezas === 1 ? "pieza" : "piezas"})</div>
                <div class="ficha-total-valor">${formatearPrecio(totalGeneral)}</div>
            </div>
            <button type="button" id="btn-confirmar-carrito" class="btn btn-primary">Confirmar pedido</button>
        </div>
    `;
}

function cablearEventosCarrito() {
    document.querySelectorAll(".carrito-item-quitar").forEach(boton => {
        boton.addEventListener("click", () => {
            const indice = Number(boton.dataset.indice);
            estado.carrito.splice(indice, 1);
            actualizarContadorCarrito();
            renderizarCarrito();
        });
    });

    document.querySelectorAll(".cantidad-btn").forEach(boton => {
        boton.addEventListener("click", () => {
            const indice = Number(boton.dataset.indice);
            const delta = Number(boton.dataset.delta);
            const item = estado.carrito[indice];
            if (!item) {
                return;
            }
            const nuevaCantidad = (item.cantidad || 1) + delta;
            if (nuevaCantidad < 1) {
                return; // para sacarlo del todo está el botón "Quitar"
            }
            item.cantidad = nuevaCantidad;
            renderizarCarrito();
        });
    });

    document.querySelectorAll(".carrito-item-editar").forEach(boton => {
        boton.addEventListener("click", () => {
            editarItemCarrito(Number(boton.dataset.indice));
        });
    });

    // Cada input actualiza estado.datosCliente al tipear, para que los
    // datos no se pierdan si el carrito se vuelve a renderizar (ej. al
    // quitar un ítem o cambiar el tipo de entrega).
    const camposTexto = {
        "carrito-input-nombre": "nombre",
        "carrito-input-telefono": "telefono",
        "carrito-input-email": "email",
        "carrito-input-direccion": "direccion",
        "carrito-input-observaciones": "observaciones"
    };

    Object.entries(camposTexto).forEach(([id, campo]) => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener("input", () => {
                estado.datosCliente[campo] = input.value;
            });
        }
    });

    const selectMetodoPago = document.getElementById("carrito-input-metodo-pago");
    if (selectMetodoPago) {
        selectMetodoPago.addEventListener("change", () => {
            estado.datosCliente.metodoPago = selectMetodoPago.value;
        });
    }

    document.querySelectorAll('input[name="carrito-entrega"]').forEach(radio => {
        radio.addEventListener("change", () => {
            estado.tipoEntrega = radio.value;
            renderizarCarrito();
        });
    });

    const botonConfirmar = document.getElementById("btn-confirmar-carrito");
    if (botonConfirmar) {
        botonConfirmar.addEventListener("click", confirmarPedidoCarrito);
    }
}


/* =========================================================
   ENVÍO DEL PEDIDO (carrito completo, un solo pedido)
   ========================================================= */

function mostrarErrorCarrito(mensaje) {
    const elemento = document.getElementById("carrito-mensaje-error");
    if (elemento) {
        elemento.textContent = mensaje;
        elemento.hidden = false;
    }
}

function ocultarErrorCarrito() {
    const elemento = document.getElementById("carrito-mensaje-error");
    if (elemento) {
        elemento.hidden = true;
    }
}

async function confirmarPedidoCarrito() {
    ocultarErrorCarrito();

    if (!estado.carrito.length) {
        return mostrarErrorCarrito("Tu carrito está vacío.");
    }

    const datos = estado.datosCliente;
    const nombre = (datos.nombre || "").trim();
    const telefono = (datos.telefono || "").trim();
    const direccion = (datos.direccion || "").trim();

    if (!nombre) {
        return mostrarErrorCarrito("Falta tu nombre.");
    }
    if (!telefono) {
        return mostrarErrorCarrito("Falta tu teléfono.");
    }
    if (estado.tipoEntrega === "envio" && !direccion) {
        return mostrarErrorCarrito("Falta la dirección de envío.");
    }
    if (!datos.metodoPago) {
        return mostrarErrorCarrito("Elegí un método de pago.");
    }

    const payload = {
        empresa_id: EMPRESA_ID,
        cliente: {
            nombre: nombre,
            telefono: telefono,
            email: (datos.email || "").trim(),
            direccion: direccion
        },
        metodo_pago: datos.metodoPago,
        tipo_entrega: estado.tipoEntrega,
        observaciones: (datos.observaciones || "").trim(),
        items: estado.carrito.flatMap(item =>
            Array.from({ length: item.cantidad || 1 }, () => ({
                modelo_id: item.modelo_id,
                color_hilo: item.color_hilo,
                talle: item.talle,
                cuello: item.cuello,
                busto: item.busto,
                cintura: item.cintura,
                alto: item.alto,
                reemplazos: item.reemplazos,
                extras: item.extras
            }))
        )
    };

    const boton = document.getElementById("btn-confirmar-carrito");
    boton.disabled = true;
    boton.textContent = "Enviando...";

    try {
        const respuesta = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ accion: "crear_pedido_publico", token: API_TOKEN, ...payload })
        });

        const resultado = await respuesta.json();

        if (!resultado.success) {
            throw new Error(resultado.error || "No se pudo enviar el pedido.");
        }

        if (resultado.advertencias && resultado.advertencias.length) {
            console.warn("Advertencias del pedido:", resultado.advertencias);
        }

        const cantidadPiezas = estado.carrito.reduce((acumulado, item) => acumulado + (item.cantidad || 1), 0);

        estado.carrito = [];
        estado.datosCliente = { nombre: "", telefono: "", email: "", direccion: "", observaciones: "", metodoPago: "" };
        estado.tipoEntrega = "envio";
        actualizarContadorCarrito();

        document.getElementById("carrito-overlay").hidden = true;
        mostrarConfirmacion(resultado, cantidadPiezas);

    } catch (error) {
        console.error(error);
        mostrarErrorCarrito(error.message);
        boton.disabled = false;
        boton.textContent = "Confirmar pedido";
    }
}

function mostrarConfirmacion(resultado, cantidadPiezas) {
    const contenido = document.getElementById("confirmacion-contenido");
    const notaPiezas = cantidadPiezas > 1 ? `<p>Pedido de ${cantidadPiezas} piezas.</p>` : "";

    contenido.innerHTML = `
        <div class="confirmacion-icono">✓</div>
        <h3>¡Pedido recibido!</h3>
        <p>Tu pedido es el número <strong>#${escaparHTML(resultado.id_pedido)}</strong>.</p>
        ${notaPiezas}
        <p>Te vamos a contactar para coordinar el pago y la entrega.</p>
        <div class="confirmacion-precio">${formatearPrecio(resultado.precio_total)}</div>
        <p class="confirmacion-nota">¿Querés hacer otro pedido? Podés volver a armarlo cuando quieras.</p>
        <button type="button" class="btn btn-primary" id="btn-cerrar-confirmacion">Volver al catálogo</button>
    `;

    document.getElementById("confirmacion-overlay").hidden = false;

    document.getElementById("btn-cerrar-confirmacion").addEventListener("click", () => {
        document.getElementById("confirmacion-overlay").hidden = true;
    });
}
