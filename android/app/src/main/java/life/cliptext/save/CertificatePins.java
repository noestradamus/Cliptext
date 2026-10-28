package life.cliptext.save;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

public final class CertificatePins {
    private CertificatePins() { }
    public static void verify(X509Certificate certificate, String expected) throws CertificateException {
        try {
            certificate.checkValidity();
            byte[] actual = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
            if (expected == null || !expected.matches("[a-f0-9]{64}")) throw new CertificateException("Invalid Mac certificate pin");
            byte[] pinned = new byte[32];
            for (int i = 0; i < 32; i++) pinned[i] = (byte) Integer.parseInt(expected.substring(i * 2, i * 2 + 2), 16);
            if (!MessageDigest.isEqual(actual, pinned)) throw new CertificateException("The Mac certificate has changed. Pair again from your Mac.");
        } catch (CertificateException invalid) { throw invalid; }
        catch (Exception invalid) { throw new CertificateException("Could not verify the Mac certificate", invalid); }
    }
}
