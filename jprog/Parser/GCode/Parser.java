package Parser.GCode;

import Display.ErrorDialog;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.util.List;
import java.util.Scanner;
import java.util.concurrent.Callable;
import java.util.concurrent.CopyOnWriteArrayList;

public class Parser implements Callable<NGCDocument> {
    public static BufferedWriter out = new BufferedWriter(new OutputStreamWriter(System.out));
    public static List<NGCDocument> parsedDocuments = new CopyOnWriteArrayList<>();

    /*
     * public static void main(String[] args) {
     * NGCDocument doc = new NGCDocument();
     * long time = -System.nanoTime();
     * try {
     * doc = parse(new File("TestFiles/butterfly!!!!_1565.ngc"));
     * out.flush();
     * } catch (Exception e) {
     * e.printStackTrace();
     * }
     * doc.getCurrentPath2D();
     * System.out.println();
     * System.out.println((System.nanoTime() + time) / 1000.0 / 1000.0 / 1000.0);
     * }
     */

    /**
     * @param fileInput
     * @return
     * @throws IOException NGC file not found, try another or use a dxf
     */
    public static NGCDocument parse(File fileInput) throws FileNotFoundException {
        int lineNum = 1;
        Scanner input;
        fileInput = new File(fileInput.getPath());
        input = new Scanner(fileInput);
        NgcStrain ngcStrain;

        if (getExt(fileInput.getName()).equalsIgnoreCase("ngc")) {
            ngcStrain = NgcStrain.router_971;
        } else if (getExt(fileInput.getName()).equalsIgnoreCase("tap")) {
            ngcStrain = NgcStrain.router_WinCNC;
        } else {
            throw new IllegalArgumentException();
        }

        NGCDocument doc = new NGCDocument(fileInput, ngcStrain);
        while (input.hasNextLine()) {
            String line = input.nextLine();
            doc.addToString(line);
            lineNum++;
            // out.write(line + "\n");
            line = ngcStrain.commentsParser.parse(line, lineNum, doc);
            if (line.contains("M")) {
                line = ngcStrain.mCodeParser.parse(line, lineNum, doc);
            } else if (line.length() > 2) {
                line = ngcStrain.gCodeParser.parse(line, lineNum, doc);
            }
            line = ngcStrain.endParser.parse(line, lineNum, doc);
        }
        input.close();
        parsedDocuments.add(doc);
        return doc;
    }

    private static String getExt(String filePath) {
        String extension = "";

        int i = filePath.lastIndexOf('.');
        int p = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));

        if (i > p) {
            extension = filePath.substring(i + 1);
        }
        return extension;
    }

    private File file;

    public Parser(File file) {
        this.file = file;
    }

    @Override
    public NGCDocument call() {
        NGCDocument output = null;
        try {
            output = parse(file);
        } catch (IOException e) {
            new ErrorDialog(e);
        }
        return output;
    }
}
