package Display;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.awt.image.WritableRaster;
import java.io.File;
import java.io.IOException;

import javax.imageio.ImageIO;

public class makeImageColorUtil {
    public static void main(String[] args) {
        Color set = new Color(140, 140, 140, 255);
        try {
            BufferedImage img = ImageIO.read(new File("gear2.png"));
            WritableRaster wrtRaster = img.getRaster();
            for (int i = 0; i < wrtRaster.getWidth(); i++) {
                for (int j = 0; j < wrtRaster.getHeight(); j++) {
                    float[] rgba = new float[4];
                    wrtRaster.getPixel(i, j, rgba);
                    if (rgba[3] != 0.0) {
                        float[] output = set.getComponents(rgba);
                        for (int k = 0; k < output.length; k++) {
                            output[k] *= 255;
                        }
                        wrtRaster.setPixel(i, j, output);
                    }
                }
            }
            ImageIO.write(img, "png", new File("gear2.png"));
        } catch (IOException e) {
        }
    }
}
