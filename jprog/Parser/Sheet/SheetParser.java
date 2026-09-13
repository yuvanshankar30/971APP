package Parser.Sheet;

import Display.ErrorDialog;
import Display.Screen;
import SheetHandler.Cut;
import SheetHandler.Hole;
import SheetHandler.Part;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOError;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Scanner;
import java.util.zip.DataFormatException;

public class SheetParser {
    public static HashMap<String, String> parseSheetFile(File sheetFile) {
        try {
            Scanner reader = new Scanner(sheetFile);
            HashMap<String, String> decodedFile = new HashMap<>();
            for (String attribute : reader.nextLine().split(",")) {

                String key = attribute.substring(0, attribute.indexOf(':'));
                key = key.replace("\"", "");
                key = key.replace("{", "");

                String value = attribute.substring(attribute.indexOf(':') + 1);
                value = value.replace("\"", "");
                value = value.replace("}", "");

                decodedFile.put(key, value);
            }
            reader.close();
            return decodedFile;
        } catch (IOException e) {
            System.err.println("Problem finding sheet!");
            e.printStackTrace();
            return new HashMap<String, String>();
        }
    }

    private static byte[] toByteArray(double value) {
        // I hate it its in little endian
        byte[] bytes = new byte[8];
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putDouble(value);
        return bytes;
    }

    private static double toDouble(byte[] bytes) {
        return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getDouble();
    }

    public static void parseCutFile(File cutFile, Cut cut) {
        try {
            FileInputStream reader = new FileInputStream(cutFile);
            if (cutFile.length() <= 0) {
                new ErrorDialog(
                        new IOError(
                                new DataFormatException(
                                        "Blank Cut File is Bad.\nPlease Delete this file and rerun")));
            }
            // get number of bytes
            int byteCounter = 0;
            int total = 0;
            int shift = 0;
            int num = 0;
            while (byteCounter <= 0 || (num & 0x80) == 0x80) {
                num = reader.read();
                total += (num & 0x7F) << shift;
                shift += 7;
                byteCounter++;
            }
            total += byteCounter;
            if (Screen.DebugMode) {
                System.out.printf("Parsing %s: %d bytes detected.%n", cutFile.getName(), byteCounter);
            }
            // x, y, rot are in sets of 64 bits
            byte[] nextNumber = new byte[8];
            while (byteCounter < total) {
                if (Screen.DebugMode) {
                    System.out.println(
                            "Part read:"
                                    + reader.readNBytes(nextNumber, 0, 8)
                                    + ": "
                                    + Arrays.toString(nextNumber));
                } else {
                    reader.readNBytes(nextNumber, 0, 8);
                }
                byteCounter += 8;
                double partX = toDouble(nextNumber);
                if (Screen.DebugMode) {
                    System.out.printf("Part %d's x is %f%n", byteCounter, partX);
                    System.out.println(
                            "Part read:"
                                    + reader.readNBytes(nextNumber, 0, 8)
                                    + ": "
                                    + Arrays.toString(nextNumber));
                } else {
                    reader.readNBytes(nextNumber, 0, 8);
                }
                byteCounter += 8;
                double partY = toDouble(nextNumber);
                if (Screen.DebugMode) {
                    System.out.printf("Part %d's y is %f%n", byteCounter, partY);
                    System.out.println(
                            "Part read:"
                                    + reader.readNBytes(nextNumber, 0, 8)
                                    + ": "
                                    + Arrays.toString(nextNumber));
                } else {
                    reader.readNBytes(nextNumber, 0, 8);
                }
                byteCounter += 8;
                double partRot = toDouble(nextNumber);
                if (Screen.DebugMode) {
                    System.out.printf("Part %d's r is %f%n", byteCounter, partRot);
                }
                // its in little endian and I hate it
                byteCounter++;
                int type = reader.read();
                if (type == 1) {
                    // is a hole
                    cut.parts.add(new Hole(cut.getHoleFile().toPath(), partX, partY, partRot));
                    if (Screen.DebugMode) {
                        System.out.println("Adding a hole");
                    }
                } else if (type == 0) {
                    // is a part(reader.read()==0)
                    int fileNameLength = reader.read();
                    byteCounter++;
                    if (fileNameLength == -1) {
                        break; // end of file
                    }
                    if (Screen.DebugMode) {
                        System.out.println("File name length: " + fileNameLength);
                    }
                    String partFileName = "";
                    for (int character = 0; character < fileNameLength; character++) {
                        partFileName += (char) reader.read();
                        byteCounter++;
                    }
                    File partFile = new File(partFileName);
                    Part tempPart = new Part(partFile, partX, partY, partRot);
                    if (tempPart != null)
                        cut.parts.add(tempPart);
                } else {
                    new ErrorDialog(
                            new IOError(
                                    new DataFormatException(
                                            "Cut file " + cutFile.getName() + " contains a non-standard part type.")));
                }
            }
            reader.close();

        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }

    public static void saveSheetInfo(File sheetFile, HashMap<String, String> sheetInfo) {
        String information = "{";
        for (String key : sheetInfo.keySet()) {
            information += "\"" + key + "\":";
            if (sheetInfo.get(key).matches("[-0123456789.]+")) {
                information += sheetInfo.get(key);
            } else {
                information += "\"" + sheetInfo.get(key) + "\"";
            }

            information += ",";
        }
        information = information.substring(0, information.length() - 1) + "}";
        try {
            FileWriter writer = new FileWriter(sheetFile);
            writer.write(information);
            writer.close();
        } catch (IOException e) {
            System.err.println("Cannot save sheet file???\n\n");
            e.printStackTrace();
        }
    }

    public static void saveCutInfo(Cut cut) {
        ArrayList<Byte> bytes = new ArrayList<>();

        for (Part part : cut.parts) {
            for (byte b : toByteArray(part.getX())) {
                bytes.add(b);
            }
            for (byte b : toByteArray(part.getY())) {
                bytes.add(b);
            }
            for (byte b : toByteArray(part.getRot())) {
                bytes.add(b);
            }
            if (part instanceof Hole) {
                bytes.add((byte) 1); // for holes
                continue;
            }
            bytes.add((byte) 0);

            String filePath = part.partFile().getPath().replace('\\', '/');
            bytes.add((byte) filePath.length());

            for (int i = 0; i < filePath.length(); i++) {
                bytes.add((byte) filePath.charAt(i));
            }
        }

        // do a wonky thing
        long numBytes = bytes.size();
        int pos = 0;
        while (numBytes != 0) {
            bytes.add(pos, (byte) ((numBytes % 128) | (numBytes / 128 != 0 ? 0x80 : 0)));
            numBytes /= 128;
            pos++;
        }

        FileOutputStream writer;
        try {
            writer = new FileOutputStream(cut.getCutFile());

            for (byte b : bytes) {
                writer.write(b);
            }
            writer.close();

        } catch (IOException e) {
            System.out.println("Cannot save cut file???\n\n");
        }
    }
}
