import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Small CLI around apksig's documented public API; no Android SDK needed. */
public final class PortableApkSigner {
  public static void main(String[] args) throws Exception {
    if (args.length != 3) throw new IllegalArgumentException("Expected input APK, output APK, and PKCS12 path.");
    char[] password = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine().toCharArray();
    KeyStore store = KeyStore.getInstance("PKCS12");
    try (FileInputStream in = new FileInputStream(args[2])) { store.load(in, password); }
    PrivateKey key = (PrivateKey) store.getKey("cliptext", password);
    Arrays.fill(password, '\0');
    List<X509Certificate> chain = new ArrayList<>();
    for (Certificate cert : store.getCertificateChain("cliptext")) chain.add((X509Certificate) cert);
    ApkSigner.SignerConfig config = new ApkSigner.SignerConfig.Builder("cliptext", key, chain).build();
    new ApkSigner.Builder(Collections.singletonList(config))
        .setInputApk(new File(args[0])).setOutputApk(new File(args[1]))
        .setMinSdkVersion(26).setV1SigningEnabled(true).setV2SigningEnabled(true)
        .setV3SigningEnabled(true).setV4SigningEnabled(false).build().sign();
    ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[1]))
        .setMinCheckedPlatformVersion(26).build().verify();
    // API26+ prefers v2/v3, so separately ask the verifier to exercise the v1
    // cryptographic path. This does not change the app's declared minSdk26.
    ApkVerifier.Result v1 = new ApkVerifier.Builder(new File(args[1]))
        .setMinCheckedPlatformVersion(23).setMaxCheckedPlatformVersion(23).build().verify();
    if (!result.isVerified() || !v1.isVerified() || !v1.isVerifiedUsingV1Scheme() || !result.isVerifiedUsingV2Scheme()) {
      throw new IllegalStateException("APK signature verification failed: " + result.getErrors());
    }
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(result.getSignerCertificates().get(0).getEncoded());
    StringBuilder hex = new StringBuilder();
    for (byte b : digest) hex.append(String.format("%02x", b & 0xff));
    System.out.println("{\"verified\":true,\"v1\":true,\"v2\":true,\"v3\":"
        + result.isVerifiedUsingV3Scheme() + ",\"certificate_sha256\":\"" + hex + "\"}");
  }
}
