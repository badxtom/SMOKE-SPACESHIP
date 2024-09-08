const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const PDFDocument = require("pdfkit");

admin.initializeApp();
sgMail.setApiKey("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");

const db = admin.firestore();
const realtimeDb = admin.database();

async function obtenerDatosCliente(clienteId) {
  const clienteRef = db.collection("clientes").doc(clienteId);
  const clienteSnap = await clienteRef.get();
  if (clienteSnap.exists) {
    return clienteSnap.data();
  } else {
    return {
      dni: "No especificado",
      number: "No especificado",
      location: "No especificada",
    };
  }
}

async function generarReporteSemanal() {
  const prestamosRef = db.collection("prestamos");
  const snapshot = await prestamosRef.get();
  const prestamos = snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));

  const reportData = await Promise.all(prestamos.map(async (prestamo) => {
    const pagosPendientes = prestamo.pagos.filter((pago) => pago.estatus === "Pendiente");
    if (pagosPendientes.length > 0) {
      const siguientePago = pagosPendientes[0];
      const clienteData = await obtenerDatosCliente(prestamo.clienteId);
      return {
        nombreCliente: prestamo.nombreCliente,
        direccion: clienteData.location,
        cedula: clienteData.dni,
        telefono: clienteData.number,
        numeroPago: siguientePago.numeroPago,
        monto: siguientePago.monto,
        numeroPrestamo: prestamo.numeroPrestamo,
      };
    }
  }));

  return reportData.filter((p) => p); // Eliminar elementos undefined si no hay pagos pendientes
}

async function generarPDF(reportData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const pdfBuffer = [];
    doc.on("data", (chunk) => pdfBuffer.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(pdfBuffer)));
    doc.on("error", reject);

    doc.fontSize(20).text("Reporte Semanal de Pagos Pendientes", {align: "center"});

    // Datos de la empresa
    realtimeDb.ref("datos/").once("value", (snapshot) => {
      const empresaData = snapshot.val();
      if (empresaData) {
        doc.fontSize(12).text(`${empresaData.name}`, {align: "left"});
        doc.text(`Teléfono: ${empresaData.number}`);
        doc.text(`Dirección: ${empresaData.location}`);
      }

      // Generar tabla con los datos filtrados
      doc.moveDown();
      doc.text("Número de Préstamo  Nombre Cliente  Cédula  Teléfono  Dirección  Número de Pago  Monto", {underline: true});
      reportData.forEach((dato) => {
        doc.text(`${dato.numeroPrestamo}  ${dato.nombreCliente}  ${dato.cedula}  ${dato.telefono}  ${dato.direccion}  ${dato.numeroPago}  ${dato.monto}`);
      });

      // Calcular la suma total de los montos a recolectar
      const totalMonto = reportData.reduce((sum, dato) => sum + parseFloat(dato.monto.replace(" DOP", "").replace(",", "")), 0);
      doc.moveDown().text(`Total a recolectar: ${totalMonto.toFixed(2)} DOP`);

      doc.end();
    });
  });
}

exports.enviarReporteSemanal = functions.pubsub.schedule("every sunday 17:30").onRun(async () => {
  try {
    const reportData = await generarReporteSemanal();
    const pdfBuffer = await generarPDF(reportData);

    // Obtener correos electrónicos de Realtime Database
    const usuariosSnapshot = await realtimeDb.ref("UsersAuthList").once("value");
    const usuarios = usuariosSnapshot.val();
    const correos = Object.values(usuarios).map((usuario) => usuario.email);

    // Enviar el PDF por correo
    const msg = {
      to: correos,
      from: "info@unoin.do",
      subject: "Reporte Semanal de Pagos Pendientes",
      text: "Adjunto encontrarás el reporte semanal de pagos pendientes.",
      attachments: [
        {
          content: pdfBuffer.toString("base64"),
          filename: "Reporte_Semanal.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    };

    await sgMail.send(msg);
    console.log("Reporte semanal enviado con éxito.");
  } catch (error) {
    console.error("Error al enviar el reporte semanal:", error);
  }
});
